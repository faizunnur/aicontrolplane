import { config } from "./config.js";
import { logger } from "./logger.js";
import { EgressBlockedError, safeFetch, type EgressOptions } from "../packages/security/src/egress.js";

const log = logger("egress");

/*
  Outbound HTTP to tenant-supplied URLs (webhooks, fire triggers, alert hooks) goes through
  the egress guard: private / loopback / metadata addresses are refused in strict mode and
  the connection is pinned to the addresses that passed the check. Strict is the default
  whenever the deployment is production OR multi-tenant (Postgres configured — the shape
  sign-ups run on), whatever NODE_ENV says: on a shared install, one workspace's webhook
  must never reach into the network the others run on. Only the test suite (NODE_ENV=test,
  webhooks on localhost by design) keeps the permissive default.
  ACP_EGRESS=permissive (or the older ACP_EGRESS_POLICY) is the explicit escape hatch for
  single-tenant self-hosters who webhook their own LAN; using it on a multi-tenant install
  is announced loudly at boot. ACP_EGRESS_ALLOWLIST names hosts allowed anywhere.
*/

const policy = ((): EgressOptions => {
  const forced = (process.env.ACP_EGRESS || process.env.ACP_EGRESS_POLICY || "").toLowerCase();
  const multiTenant = config.db.driver === "pg";
  const isTest = process.env.NODE_ENV === "test";
  const p = forced === "strict" || forced === "permissive" ? forced : config.isProd || (multiTenant && !isTest) ? "strict" : "permissive";
  if (p === "permissive" && forced === "permissive" && (multiTenant || config.isProd)) {
    log.warn("ACP_EGRESS=permissive on a Postgres/production deployment: tenant-supplied webhooks MAY REACH PRIVATE ADDRESSES (loopback, LAN, cloud metadata). Only keep this on a single-tenant install that trusts every workspace.");
  }
  const allowlist = (process.env.ACP_EGRESS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { policy: p, allowlist };
})();

log.info(`egress policy: ${policy.policy}${policy.allowlist?.length ? ` (allowlist: ${policy.allowlist.join(", ")})` : ""}`);

export { EgressBlockedError };

export function egressFetch(url: string | URL, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  return safeFetch(url, init, policy);
}
