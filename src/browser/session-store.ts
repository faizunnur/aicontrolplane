import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { currentOrgId, getBrowserSession, setBrowserSession, withOrg } from "../db.js";

const inHomeOrg = <T>(fn: () => T): T => withOrg(currentOrgId() ?? 1, fn);
import { logger } from "../logger.js";
import { visiblePlatforms } from "../platforms.js";
import { cookieMatchesDomain, sessionDomains } from "../providers/browser/domains.js";
import { isSealed, open, seal } from "../secrets.js";

const log = logger("session-store");

/*
  Where the browser's signed-in state (cookies + localStorage) survives a lost profile.
  It is sealed with the deployment's envelope key and stored in the database - never again
  as plaintext on disk or in a mirror. The old plaintext sessions.json is read once as a
  fallback for existing deployments, then superseded.

  Two granularities live side by side:
    "default"        the whole persistent profile, as one blob — the legacy single-browser
                     backup/restore path, kept working verbatim.
    "<platformId>"   one provider's slice of it, per workspace — what the fleet's ephemeral
                     contexts are seeded from. The legacy backup dual-writes these, so a
                     deployment that later turns the fleet on finds its sign-ins waiting.
*/

const DEFAULT_ID = "default"; // one shared browser today; per provider-connection when the browser fleet splits

const legacyFile = () => path.join(config.dataDir, "sessions.json");

/** The shape Playwright's storageState() returns and newContext({storageState}) accepts. */
export interface StorageStateLike {
  cookies?: { name: string; value: string; domain: string; [k: string]: unknown }[];
  origins?: { origin: string; [k: string]: unknown }[];
}

/** One provider's slice of a whole-profile storageState, by its session domains. */
export function sliceStateForPlatform(state: StorageStateLike, p: { cookieDomain: string; appUrl: string; chatUrl: string; tasksUrl: string; sessionDomains: string[] }): StorageStateLike {
  const domains = sessionDomains(p);
  const originMatches = (origin: string) => {
    try {
      const host = new URL(origin).hostname.toLowerCase();
      return domains.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };
  return {
    cookies: (state.cookies ?? []).filter((c) => c && c.name && c.domain && cookieMatchesDomain(c.domain, domains)),
    origins: (state.origins ?? []).filter((o) => o && originMatches(o.origin)),
  };
}

/** One provider's sealed session for the ambient workspace. */
export async function saveConnectionState(platformId: string, stateJson: string): Promise<void> {
  await inHomeOrg(async () => setBrowserSession(platformId, await seal(stateJson)));
}
export async function loadConnectionState(platformId: string): Promise<string | null> {
  const sealed = await inHomeOrg(() => getBrowserSession(platformId));
  if (sealed) {
    try {
      return isSealed(sealed) ? await open(sealed) : sealed;
    } catch (err) {
      log.error(`stored ${platformId} session cannot be unsealed (wrong ACP_MASTER_KEY?)`, err);
      return null;
    }
  }
  // Nothing per-provider yet: an install that predates the fleet holds one whole-profile
  // blob. Its slice for this provider bootstraps the connection — no one signs in again.
  const whole = await loadSessionState();
  if (!whole) return null;
  const p = visiblePlatforms().find((x) => x.id === platformId);
  if (!p) return null;
  try {
    const slice = sliceStateForPlatform(JSON.parse(whole) as StorageStateLike, p);
    return slice.cookies?.length || slice.origins?.length ? JSON.stringify(slice) : null;
  } catch {
    return null;
  }
}

export async function saveSessionState(stateJson: string): Promise<void> {
  await inHomeOrg(async () => setBrowserSession(DEFAULT_ID, await seal(stateJson)));
  // Dual-write the per-provider slices so the fleet (or a later migration to it) starts from
  // today's sign-ins. Best effort: the whole-profile blob above is the source of truth here.
  try {
    const state = JSON.parse(stateJson) as StorageStateLike;
    for (const p of visiblePlatforms()) {
      const slice = sliceStateForPlatform(state, p);
      if (slice.cookies?.length || slice.origins?.length) await saveConnectionState(p.id, JSON.stringify(slice));
    }
  } catch (err) {
    log.warn("per-provider session split failed (whole-profile backup unaffected)", err);
  }
  // The plaintext file must not linger once the sealed copy exists.
  try {
    if (fs.existsSync(legacyFile())) {
      fs.rmSync(legacyFile());
      log.info("removed plaintext sessions.json; session state is now sealed in the database");
    }
  } catch {
    /* leave it; next save retries */
  }
}

export async function loadSessionState(): Promise<string | null> {
  const sealed = await inHomeOrg(() => getBrowserSession(DEFAULT_ID));
  if (sealed) {
    try {
      return isSealed(sealed) ? await open(sealed) : sealed;
    } catch (err) {
      log.error("stored session state cannot be unsealed (wrong ACP_MASTER_KEY?)", err);
      return null;
    }
  }
  try {
    if (fs.existsSync(legacyFile())) return fs.readFileSync(legacyFile(), "utf8");
  } catch {
    /* unreadable legacy file */
  }
  return null;
}
