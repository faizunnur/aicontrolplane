/**
 * Import this first in every unit test. It points the app at a throw-away data folder and
 * turns off everything that would reach outside the process (browser, scheduler, LLM routing).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-unit-"));
process.env.DATA_DIR = testDataDir;
process.env.BROWSER_ENABLED = "false";
process.env.SYNC_ENABLED = "false";
process.env.ROUTER_PROVIDER = "none";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
