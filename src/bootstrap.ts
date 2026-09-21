/**
 * Entry point. Restores the small state files from Postgres (when DATABASE_URL is set)
 * before anything opens the SQLite database, then starts the server.
 */
import { restoreFromDatabase } from "./persist.js";

try {
  await restoreFromDatabase();
} catch (err) {
  console.error("[bootstrap] restore failed, starting with local files", err);
}
await import("./server.js");
