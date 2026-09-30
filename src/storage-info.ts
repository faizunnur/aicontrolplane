import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { browserSessionUpdatedAt, currentOrgId, withOrg } from "./db.js";
import { persistStatus } from "./persist.js";

/** What keeps sign-ins and data across redeploys, for the settings page and diagnostics. Cloud-side only. */
export async function storageInfo(): Promise<{
  dataDir: string;
  /** Whether the data dir is on a persistent mount; null when unknown. */
  persistent: boolean | null;
  mount: string | null;
  backupAt: string | null;
  /** What keeps state across redeploys. "unknown" when the platform cannot tell (e.g. local dev). */
  persistedBy: "postgres" | "volume" | "database" | "none" | "unknown";
  database: { enabled: boolean; lastSaveAt: string | null; lastError: string | null };
}> {
  let persistent: boolean | null = null;
  let mount: string | null = null;
  try {
    if (process.platform === "linux" && fs.existsSync("/proc/mounts")) {
      const mounts = fs
        .readFileSync("/proc/mounts", "utf8")
        .split("\n")
        .map((l) => l.split(" ")[1])
        .filter(Boolean)
        .filter((m) => m !== "/" && !m.startsWith("/proc") && !m.startsWith("/sys") && !m.startsWith("/dev") && m !== "/etc/hosts" && m !== "/etc/hostname" && m !== "/etc/resolv.conf");
      const dir = path.resolve(config.dataDir);
      mount = mounts.filter((m) => dir === m || dir.startsWith(m + "/")).sort((a, b) => b.length - a.length)[0] ?? null;
      persistent = mount !== null;
    }
  } catch {
    persistent = null;
  }
  let backupAt: string | null = null;
  try {
    backupAt = (await withOrg(currentOrgId() ?? 1, () => browserSessionUpdatedAt("default"))) ?? null;
    if (!backupAt) {
      const f = path.join(config.dataDir, "sessions.json");
      if (fs.existsSync(f)) backupAt = fs.statSync(f).mtime.toISOString();
    }
  } catch {
    backupAt = null;
  }
  const database = persistStatus();
  // Postgres as the primary database persists everything by itself; the volume/mirror story
  // only applies to SQLite mode.
  const persistedBy = config.db.driver === "pg" ? "postgres" : database.enabled && !database.lastError ? "database" : persistent === true ? "volume" : persistent === false ? "none" : "unknown";
  return { dataDir: config.dataDir, persistent, mount, backupAt, persistedBy, database };
}
