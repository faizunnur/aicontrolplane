/*
  Which cookies and origins belong to a provider's session. Pure: no imports beyond types, so the
  helper that runs on the user's own computer (scripts/connect.ts) uses the very same rules the
  server applies. The server never trusts the helper's filtering; it filters again.
*/

export interface SessionDomainSource {
  cookieDomain: string;
  appUrl: string;
  chatUrl: string;
  tasksUrl: string;
  sessionDomains: string[];
}

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}
export interface StoredOrigin {
  origin: string;
  localStorage: { name: string; value: string }[];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const strip = (d: string) =>
  d
    .trim()
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/^www\./, "");

/** The domains a provider's session lives on: its cookie domain, its pages' hosts, and any it declares. */
export function sessionDomains(p: SessionDomainSource): string[] {
  const out = new Set<string>();
  for (const d of [p.cookieDomain, hostOf(p.appUrl), hostOf(p.chatUrl), hostOf(p.tasksUrl), ...(p.sessionDomains ?? [])]) {
    const s = strip(String(d ?? ""));
    if (s) out.add(s);
  }
  return [...out];
}

/** ".x.ai", "accounts.x.ai" and "x.ai" all belong to "x.ai"; "notx.ai" does not. */
export function cookieMatchesDomain(cookieDomain: string, domains: string[]): boolean {
  const host = String(cookieDomain ?? "")
    .toLowerCase()
    .replace(/^\./, "");
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith("." + d));
}

export interface SelectCaps {
  cookies: number;
  origins: number;
  entries: number;
  valueBytes: number;
}
const DEFAULT_CAPS: SelectCaps = { cookies: 500, origins: 50, entries: 200, valueBytes: 64_000 };

/** Keep only well-formed cookies and origins for these domains. Drops the rest silently and counts them. */
export function selectProviderState(state: { cookies?: unknown; origins?: unknown }, domains: string[], caps: Partial<SelectCaps> = {}): { cookies: StoredCookie[]; origins: StoredOrigin[]; dropped: number } {
  const c = { ...DEFAULT_CAPS, ...caps };
  const nowSec = Date.now() / 1000;
  let dropped = 0;
  const cookies: StoredCookie[] = [];
  for (const raw of Array.isArray(state.cookies) ? state.cookies : []) {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== "object" || typeof r.name !== "string" || typeof r.value !== "string" || typeof r.domain !== "string" || !r.name || !r.domain) {
      dropped++;
      continue;
    }
    if (!cookieMatchesDomain(r.domain, domains)) {
      dropped++;
      continue;
    }
    const expires = typeof r.expires === "number" && Number.isFinite(r.expires) ? r.expires : -1;
    if (expires > 0 && expires < nowSec) {
      dropped++;
      continue;
    }
    if (cookies.length >= c.cookies || r.value.length > c.valueBytes) {
      dropped++;
      continue;
    }
    const sameSite = r.sameSite === "Strict" || r.sameSite === "None" ? r.sameSite : "Lax";
    cookies.push({ name: r.name, value: r.value, domain: r.domain, path: typeof r.path === "string" && r.path ? r.path : "/", expires, httpOnly: r.httpOnly === true, secure: r.secure === true, sameSite });
  }
  const origins: StoredOrigin[] = [];
  for (const raw of Array.isArray(state.origins) ? state.origins : []) {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== "object" || typeof r.origin !== "string" || !Array.isArray(r.localStorage)) {
      dropped++;
      continue;
    }
    const host = hostOf(r.origin);
    if (!host || !cookieMatchesDomain(host, domains) || origins.length >= c.origins) {
      dropped++;
      continue;
    }
    const entries: { name: string; value: string }[] = [];
    for (const e of r.localStorage as unknown[]) {
      const x = e as Record<string, unknown>;
      if (!x || typeof x.name !== "string" || typeof x.value !== "string" || x.value.length > c.valueBytes || entries.length >= c.entries) {
        dropped++;
        continue;
      }
      entries.push({ name: x.name, value: x.value });
    }
    if (entries.length) origins.push({ origin: new URL(r.origin).origin, localStorage: entries });
  }
  return { cookies, origins, dropped };
}
