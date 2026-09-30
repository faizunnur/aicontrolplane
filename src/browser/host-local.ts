import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { addAudit, addCapture, cancelRequested, claimProvider, currentOrgId, pruneCaptures, releaseProviderClaim, renewProviderClaim, setPlatformState } from "../db.js";
import { saveToDatabase } from "../persist.js";
import { getPlatform } from "../platforms.js";
import type { ConnectorHost } from "./host.js";
import { loadConnectionState, loadSessionState, saveConnectionState, saveSessionState } from "./session-store.js";

/*
  The database-backed host: what the browser code talked to directly before the seam, moved
  behind the interface unchanged. Runs in every cloud process that holds a browser.
*/
export const localHost: ConnectorHost = {
  async setPlatformState(platformId, patch) {
    await setPlatformState(platformId, patch);
  },
  addCapture: (c) => addCapture(c),
  pruneCaptures: (platformId) => pruneCaptures(platformId),
  async saveScreenshot(platformId, png) {
    // One file per (workspace, provider): two workspaces' screenshots must never share a path.
    const dir = path.join(config.screenshotDir, String(currentOrgId() ?? 1));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${platformId}.png`);
    fs.writeFileSync(file, png);
    await setPlatformState(platformId, { screenshot_path: file });
    return file;
  },
  loadSessionState: async (platformId) => (platformId ? loadConnectionState(platformId) : loadSessionState()),
  async saveSessionState(stateJson, platformId) {
    if (platformId) {
      await saveConnectionState(platformId, stateJson);
      return;
    }
    await saveSessionState(stateJson);
    // The legacy profile is also mirrored to Postgres (SQLite installs); best effort, never awaited.
    void saveToDatabase().catch(() => undefined);
  },
  claimProvider: (platformId, owner, ttlMs) => claimProvider(platformId, owner, ttlMs),
  renewProviderClaim: (platformId, owner, ttlMs) => renewProviderClaim(platformId, owner, ttlMs),
  releaseProviderClaim: (platformId, owner) => releaseProviderClaim(platformId, owner),
  platform: async (platformId) => getPlatform(platformId),
  async audit(entry) {
    await addAudit(entry);
  },
  isCancelled: (runId) => cancelRequested(runId),
};
