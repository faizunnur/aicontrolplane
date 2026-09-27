import { bus } from "./bus.js";
import { config } from "./config.js";
import { initData } from "../packages/data/src/index.js";

/*
  The app's face of the data layer (packages/data): importing this module opens the database
  at the configured path and wires row-change announcements onto the in-process bus. Every
  module keeps importing "./db.js" as before; only the wiring lives here.
*/

initData({ dbPath: config.dbPath, notify: (topic, payload) => bus.emit(topic, payload) });

export * from "../packages/data/src/index.js";
