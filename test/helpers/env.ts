/**
 * Import this first in every unit test. It points the app at a throw-away data folder and
 * turns off everything that would reach outside the process (browser, scheduler, LLM routing).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-unit-"));
process.env.DATA_DIR = testDataDir;
process.env.BROWSER_ENABLED = "false";
process.env.SYNC_ENABLED = "false";
process.env.ROUTER_PROVIDER = "none";
process.env.NODE_ENV = "test";
// Quotas off by default: suites accumulate active runs across cases, and the point of a unit
// test is never the install-wide default ceiling. Quota tests set orgs.quotas explicitly.
process.env.ORG_MAX_CONCURRENT_RUNS = "0";
process.env.ORG_MAX_RUNS_PER_DAY = "0";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

/**
 * Conformance mode: TEST_PG_URL points at a Postgres server, and the whole suite runs against
 * it instead of SQLite. Each test process gets its own throw-away database, because the files
 * run in parallel and every one assumes a fresh store.
 */
// Unit tests exercise the data layer directly, and node:test callbacks run outside any async
// scope entered here — so the data layer accepts this default workspace in their stead. The
// spawned-server e2e suite does not set it: there, an unscoped query still throws.
process.env.ACP_TEST_DEFAULT_ORG = "1";

export const testDriver: "sqlite" | "pg" = process.env.TEST_PG_URL ? "pg" : "sqlite";
if (process.env.TEST_PG_URL) {
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: process.env.TEST_PG_URL });
  await admin.connect();
  const name = `acp_unit_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(process.env.TEST_PG_URL);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
}
