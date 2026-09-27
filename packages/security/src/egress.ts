import dns from "node:dns";
import net from "node:net";
// undici's own fetch, so the pinning Agent and the fetch implementation always match
// (a dispatcher from one undici is rejected by another's fetch).
import { Agent, fetch as undiciFetch } from "undici";

/*
  The egress guard: every outbound HTTP request to a tenant-supplied URL (webhooks, task
  fire triggers, alert URLs) goes through here. It resolves the hostname FIRST, refuses
  private / loopback / link-local / metadata ranges, and then pins the connection to the
  addresses it validated — DNS rebinding cannot swap in an internal address between the
  check and the connect.

  Policy: "strict" denies private ranges (production default); "permissive" allows them
  (development and tests, self-hosted deployments that webhook their own LAN). Hosts in
  the allowlist pass even under strict.
*/

export type EgressPolicy = "strict" | "permissive";

export interface EgressOptions {
  policy: EgressPolicy;
  /** Hostnames (exact, lowercased) allowed to resolve anywhere, even under strict. */
  allowlist?: string[];
}

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressBlockedError";
  }
}

function isPrivate(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivate(low.slice("::ffff:".length));
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // unparseable: refuse
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function resolveChecked(host: string, opts: EgressOptions): Promise<string[]> {
  const allow = (opts.allowlist ?? []).includes(host.toLowerCase());
  const literal = net.isIP(host) ? [host] : null;
  const addrs = literal ?? (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addrs.length) throw new EgressBlockedError(`${host} does not resolve`);
  if (opts.policy === "strict" && !allow) {
    for (const ip of addrs) {
      if (isPrivate(ip)) throw new EgressBlockedError(`${host} resolves to a private address (${ip}); refusing to call it`);
    }
  }
  return addrs;
}

/**
 * fetch() for tenant-supplied URLs: scheme-checked, resolved, range-checked, and pinned to
 * the validated addresses for the actual connection.
 */
export async function safeFetch(url: string | URL, init: RequestInit & { timeoutMs?: number } | undefined, opts: EgressOptions): Promise<Response> {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new EgressBlockedError(`only http(s) may be called, not ${u.protocol}`);
  const addrs = await resolveChecked(u.hostname, opts);
  // Pin: the connection may only use the addresses that passed the check above.
  const dispatcher = new Agent({
    connect: {
      lookup: (host, _o, cb) => {
        if (host.toLowerCase() !== u.hostname.toLowerCase()) return cb(new EgressBlockedError(`unexpected host ${host}`), []);
        cb(
          null,
          addrs.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })),
        );
      },
    },
  });
  try {
    const { timeoutMs, ...rest } = init ?? {};
    const signal = rest.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
    return (await undiciFetch(u, { ...(rest as object), signal, dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  } finally {
    // Close lazily; in-flight bodies keep their connection until read.
    setTimeout(() => void dispatcher.close().catch(() => undefined), 60_000).unref?.();
  }
}
