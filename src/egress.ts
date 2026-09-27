import { config } from "./config.js";
import { logger } from "./logger.js";
import { EgressBlockedError, safeFetch, type EgressOptions } from "../packages/security/src/egress.js";

const log = logger("egress");

/*
  Outbound HTTP to tenant-supplied URLs (webhooks, fire triggers, alert hooks) goes through
  the egress guard: private / loopback / metadata addresses are refused in strict mode and
  the connection is pinned to the addresses that passed the check. Production defaults to
  strict; development and tests default to permissive (their webhooks live on localhost).
  ACP_EGRESS_POLICY overrides; ACP_EGRESS_ALLOWLIST names hosts allowed anywhere.
*/

const policy = ((): EgressOptions => {
  const forced = (process.env.ACP_EGRESS_POLICY || "").toLowerCase();
  const p = forced === "strict" || forced === "permissive" ? forced : config.isProd ? "strict" : "permissive";
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
