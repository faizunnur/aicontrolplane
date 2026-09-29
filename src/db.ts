import { bus } from "./bus.js";
import { config } from "./config.js";
import { initData } from "../packages/data/src/index.js";
import { seal } from "./secrets.js";

/*
  The app's face of the data layer (packages/data): importing this module opens the database
  (Postgres when DATABASE_URL is set, the local SQLite file otherwise) and wires row-change
  announcements onto the in-process bus. Every module keeps importing "./db.js" as before;
  only the wiring lives here.
*/

await initData({ dbPath: config.dbPath, databaseUrl: config.db.url || undefined, driver: config.db.driver, notify: (topic, payload, outboxId, orgId) => bus.emit(topic, payload, outboxId, orgId), sealSecret: (v) => seal(v) });

export * from "../packages/data/src/index.js";
