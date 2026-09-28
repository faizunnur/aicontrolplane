/**
 * Entry point. Restores the small state files from the legacy mirror (SQLite mode with
 * PERSIST_DATABASE_URL) before anything opens the database, then starts whatever this
 * process's ROLE says it is: the whole platform (all), the HTTP face (api), or an
 * executor (worker).
 */
import { config } from "./config.js";
import { restoreFromDatabase } from "./persist.js";

// Split processes seal and open each other's secrets (a webhook token saved through the api is
// opened by a worker). A key generated per process would make those unreadable, silently.
if (config.role !== "all" && !process.env.ACP_MASTER_KEY) {
  console.error(`[bootstrap] ROLE=${config.role} needs ACP_MASTER_KEY, the same value on every service (generate one with: openssl rand -hex 32)`);
  process.exit(1);
}
if (config.role !== "all" && config.db.driver !== "pg") {
  console.error(`[bootstrap] ROLE=${config.role} needs DATABASE_URL (Postgres): the job queue and shared state live there`);
  process.exit(1);
}

try {
  await restoreFromDatabase();
} catch (err) {
  console.error("[bootstrap] restore failed, starting with local files", err);
}

if (config.role === "worker") await import("../apps/worker/src/main.js");
else if (config.role === "browser") await import("../apps/browser-worker/src/main.js");
else await import("./server.js");
