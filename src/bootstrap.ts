/**
 * Entry point. Restores the small state files from the legacy mirror (SQLite mode with
 * PERSIST_DATABASE_URL) before anything opens the database, then starts whatever this
 * process's ROLE says it is: the whole platform (all), the HTTP face (api), or an
 * executor (worker).
 */
import { config } from "./config.js";
import { restoreFromDatabase } from "./persist.js";

try {
  await restoreFromDatabase();
} catch (err) {
  console.error("[bootstrap] restore failed, starting with local files", err);
}

if (config.role === "worker") await import("../apps/worker/src/main.js");
else await import("./server.js");
