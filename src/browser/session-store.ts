import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { currentOrgId, getBrowserSession, setBrowserSession, withOrg } from "../db.js";

const inHomeOrg = <T>(fn: () => T): T => withOrg(currentOrgId() ?? 1, fn);
import { logger } from "../logger.js";
import { isSealed, open, seal } from "../secrets.js";

const log = logger("session-store");

/*
  Where the browser's signed-in state (cookies + localStorage) survives a lost profile.
  It is sealed with the deployment's envelope key and stored in the database - never again
  as plaintext on disk or in a mirror. The old plaintext sessions.json is read once as a
  fallback for existing deployments, then superseded.
*/

const DEFAULT_ID = "default"; // one shared browser today; per provider-connection when the browser fleet splits

const legacyFile = () => path.join(config.dataDir, "sessions.json");

export async function saveSessionState(stateJson: string): Promise<void> {
  await inHomeOrg(async () => setBrowserSession(DEFAULT_ID, await seal(stateJson)));
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
