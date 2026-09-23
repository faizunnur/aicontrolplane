import "../helpers/env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { testDataDir } from "../helpers/env.js";

/*
  A database exactly as the first releases wrote it, with rows in the old shape, opened by the
  current code. Everything must still be there under the new names.
*/
const OLD_SCHEMA = `
CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'registry', purpose TEXT, schedule TEXT, native_url TEXT, status TEXT, enabled INTEGER NOT NULL DEFAULT 1, meta TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(platform, key));
CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE, external_id TEXT, status TEXT NOT NULL, started_at TEXT, finished_at TEXT, summary TEXT, details TEXT, output_url TEXT, source TEXT NOT NULL, raw TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX runs_agent_external ON runs(agent_id, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, read INTEGER NOT NULL DEFAULT 0, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, dedupe_key TEXT UNIQUE);
CREATE TABLE platform_state (platform TEXT PRIMARY KEY, session_status TEXT NOT NULL DEFAULT 'unknown', last_sync_at TEXT, last_ok_at TEXT, last_error TEXT, screenshot_path TEXT, meta TEXT);
CREATE TABLE captures (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, url TEXT NOT NULL, method TEXT, status INTEGER, content_type TEXT, body TEXT, size INTEGER, captured_at TEXT NOT NULL);
CREATE TABLE sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, message TEXT, agents_found INTEGER, runs_found INTEGER, captures INTEGER);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'needs_assignment', agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL, suggestions TEXT, routing TEXT, delivery_mode TEXT, delivered_at TEXT, acked_at TEXT, response TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

describe("migration from the first-release schema", () => {
  it("renames agents to tasks, rebuilds runs, keeps every row, and adds run_events", async () => {
    const file = path.join(testDataDir, "acp.sqlite");
    fs.rmSync(file, { force: true });
    const old = new Database(file);
    old.exec(OLD_SCHEMA);
    const ts = "2026-09-01T00:00:00.000Z";
    old.prepare("INSERT INTO agents (platform, key, name, source, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("chatgpt", "t1", "Daily briefing", "discovered", "daily", ts, ts);
    old.prepare("INSERT INTO agents (platform, key, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("custom", "audit", "Nightly audit", "push", ts, ts);
    old.prepare("INSERT INTO runs (agent_id, external_id, status, finished_at, summary, source, created_at) VALUES (1, 'r1', 'success', ?, 'ok', 'collector', ?)").run(ts, ts);
    old.prepare("INSERT INTO runs (agent_id, external_id, status, finished_at, summary, source, created_at) VALUES (2, 'e9', 'failed', ?, 'boom', 'push', ?)").run(ts, ts);
    old.prepare("INSERT INTO messages (text, status, agent_id, created_at, updated_at) VALUES ('hi', 'done', 2, ?, ?)").run(ts, ts);
    old.prepare("INSERT INTO settings (key, value) VALUES ('admin_password_hash', 'x')").run();
    old.close();

    const db = await import("../../src/db.js");
    assert.deepEqual(db.schemaVersion().map((m) => m.id), [1, 2, 3, 4, 5, 6]);
    const tasks = db.listTasks({ includeDisabled: true });
    assert.deepEqual(tasks.map((t) => [t.platform, t.key, t.name]), [["chatgpt", "t1", "Daily briefing"], ["custom", "audit", "Nightly audit"]]);
    const runs = db.listRuns({ limit: 10 });
    assert.equal(runs.length, 2);
    const r1 = runs.find((r) => r.external_id === "r1")!;
    assert.equal(r1.task_id, 1);
    assert.equal(r1.kind, "discovered");
    assert.equal(r1.provider, "chatgpt");
    assert.equal(r1.label, "Daily briefing");
    assert.equal(r1.task_name, "Daily briefing");
    const e9 = runs.find((r) => r.external_id === "e9")!;
    assert.equal(e9.kind, "external");
    assert.equal(e9.status, "failed");
    const m = db.listMessages({ limit: 1 })[0];
    assert.equal(m.task_id, 2);
    assert.equal(m.task_name, "Nightly audit");
    assert.equal(m.run_id, null);
    assert.equal(db.getSetting("admin_password_hash"), "x");
    assert.equal(db.runEvents(r1.id).length, 0);
    // The old, task-bound unique index is gone and the new one dedupes the same way.
    const again = db.recordRun({ task_id: 1, external_id: "r1", status: "success", source: "collector" });
    assert.equal(again.created, false);
    // Running the migrations again is a no-op.
    assert.deepEqual(db.schemaVersion().map((x) => x.id), [1, 2, 3, 4, 5, 6]);
  });
});
