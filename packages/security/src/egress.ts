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

/**
 * Parse an IPv6 literal into its eight 16-bit hextets. IPv6 has too many spellings for
 * string prefixes to be a check ("0:0:0:0:0:0:0:1", "::0:1" and "::1" are the same
 * address), so the address is canonicalized first and the ranges compared numerically.
 * Null when it does not parse — which the caller treats as private, like the IPv4 branch.
 */
function parseIPv6(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf("%"); // fe80::1%eth0 — the zone id is not part of the address
  if (zone >= 0) s = s.slice(0, zone);
  // An embedded dotted IPv4 tail (::ffff:127.0.0.1) becomes its two hextets.
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.slice(lastColon + 1).includes(".")) {
    const dotted = s.slice(lastColon + 1).split(".").map(Number);
    if (dotted.length !== 4 || dotted.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    s = s.slice(0, lastColon + 1) + ((dotted[0] << 8) | dotted[1]).toString(16) + ":" + ((dotted[2] << 8) | dotted[3]).toString(16);
  }
  // Expand "::" into however many zero hextets it stands for. At most one is allowed.
  const dbl = s.indexOf("::");
  if (dbl !== s.lastIndexOf("::")) return null;
  let fields: string[];
  if (dbl >= 0) {
    const head = s.slice(0, dbl).split(":").filter(Boolean);
    const tail = s.slice(dbl + 2).split(":").filter(Boolean);
    if (head.length + tail.length > 7) return null;
    fields = [...head, ...new Array(8 - head.length - tail.length).fill("0"), ...tail];
  } else {
    fields = s.split(":");
    if (fields.length !== 8) return null;
  }
  const hextets = fields.map((h) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return hextets.some(Number.isNaN) ? null : hextets;
}

/** The four octets embedded in a mapped/translated IPv6 address's last two hextets. */
function embeddedV4(h6: number, h7: number): string {
  return `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  const h = parseIPv6(ip);
  if (!h) return true; // unparseable: refuse, same philosophy as the IPv4 branch
  const leadingZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  if (leadingZero && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated, still routable on LANs)
  if ((h[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  // Addresses that are REALLY an IPv4 destination judge the IPv4 they carry:
  if (leadingZero && h[5] === 0xffff) return isPrivate(embeddedV4(h[6], h[7])); // v4-mapped ::ffff:0:0/96
  if (leadingZero && h[5] === 0) return isPrivate(embeddedV4(h[6], h[7])); // v4-compatible ::/96 (everything else in it was caught above)
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return isPrivate(embeddedV4(h[6], h[7])); // NAT64 64:ff9b::/96
  return false;
}

export function isPrivate(ip: string): boolean {
  if (net.isIPv6(ip)) return isPrivateV6(ip);
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
