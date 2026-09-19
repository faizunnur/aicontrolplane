import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Agent, AgentSource, EventRow, PlatformState, Run, RunStatus, SessionStatus } from "./types.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'registry',
  purpose TEXT,
  schedule TEXT,
  native_url TEXT,
  status TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  meta TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, key)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  external_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  summary TEXT,
  details TEXT,
  output_url TEXT,
  source TEXT NOT NULL,
  raw TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_agent_external ON runs(agent_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dedupe_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS platform_state (
  platform TEXT PRIMARY KEY,
  session_status TEXT NOT NULL DEFAULT 'unknown',
  last_sync_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  screenshot_path TEXT,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT,
  status INTEGER,
  content_type TEXT,
  body TEXT,
  size INTEGER,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS captures_platform ON captures(platform, captured_at DESC);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  message TEXT,
  agents_found INTEGER,
  runs_found INTEGER,
  captures INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const now = () => new Date().toISOString();

/* ---------- agents ---------- */

export interface AgentInput {
  platform: string;
  key: string;
  /** Falls back to key on insert; left unchanged on update when omitted. */
  name?: string;
  source?: AgentSource;
  purpose?: string | null;
  schedule?: string | null;
  native_url?: string | null;
  status?: string | null;
  enabled?: boolean;
  meta?: unknown;
}

export function listAgents(opts: { platform?: string; includeDisabled?: boolean } = {}): (Agent & { last_run?: Run | null })[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.platform) {
    where.push("a.platform = ?");
    params.push(opts.platform);
  }
  if (!opts.includeDisabled) where.push("a.enabled = 1");
  const sql = `SELECT a.* FROM agents a ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.platform, a.name`;
  const agents = db.prepare(sql).all(...params) as Agent[];
  const lastRun = db.prepare(`SELECT * FROM runs WHERE agent_id = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC LIMIT 1`);
  return agents.map((a) => ({ ...a, last_run: (lastRun.get(a.id) as Run | undefined) ?? null }));
}

export function getAgent(id: number): Agent | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
}

export function findAgent(platform: string, key: string): Agent | undefined {
  return db.prepare("SELECT * FROM agents WHERE platform = ? AND key = ?").get(platform, key) as Agent | undefined;
}

/** Insert or update by (platform, key). Fields that are undefined are left untouched on update. */
export function upsertAgent(input: AgentInput): Agent {
  const existing = findAgent(input.platform, input.key);
  const ts = now();
  const meta = input.meta === undefined ? undefined : JSON.stringify(input.meta);
  if (existing) {
    db.prepare(
      `UPDATE agents SET
         name = COALESCE(?, name),
         source = COALESCE(?, source),
         purpose = COALESCE(?, purpose),
         schedule = COALESCE(?, schedule),
         native_url = COALESCE(?, native_url),
         status = COALESCE(?, status),
         enabled = COALESCE(?, enabled),
         meta = COALESCE(?, meta),
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name ?? null,
      input.source ?? null,
      input.purpose ?? null,
      input.schedule ?? null,
      input.native_url ?? null,
      input.status ?? null,
      input.enabled === undefined ? null : input.enabled ? 1 : 0,
      meta ?? null,
      ts,
      existing.id,
    );
    return getAgent(existing.id)!;
  }
  const res = db
    .prepare(
      `INSERT INTO agents (platform, key, name, source, purpose, schedule, native_url, status, enabled, meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.platform,
      input.key,
      input.name ?? input.key,
      input.source ?? "registry",
      input.purpose ?? null,
      input.schedule ?? null,
      input.native_url ?? null,
      input.status ?? null,
      input.enabled === false ? 0 : 1,
      meta ?? null,
      ts,
      ts,
    );
  return getAgent(Number(res.lastInsertRowid))!;
}

export function updateAgent(id: number, patch: Partial<AgentInput>): Agent | undefined {
  const a = getAgent(id);
  if (!a) return undefined;
  db.prepare(
    `UPDATE agents SET name=?, purpose=?, schedule=?, native_url=?, status=?, enabled=?, meta=?, platform=?, key=?, updated_at=? WHERE id=?`,
  ).run(
    patch.name ?? a.name,
    patch.purpose === undefined ? a.purpose : patch.purpose,
    patch.schedule === undefined ? a.schedule : patch.schedule,
    patch.native_url === undefined ? a.native_url : patch.native_url,
    patch.status === undefined ? a.status : patch.status,
    patch.enabled === undefined ? a.enabled : patch.enabled ? 1 : 0,
    patch.meta === undefined ? a.meta : JSON.stringify(patch.meta),
    patch.platform ?? a.platform,
    patch.key ?? a.key,
    now(),
    id,
  );
  return getAgent(id);
}

export function deleteAgent(id: number): boolean {
  return db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
}

/* ---------- runs ---------- */

export interface RunInput {
  agent_id: number;
  external_id?: string | null;
  status: RunStatus;
  started_at?: string | null;
  finished_at?: string | null;
  summary?: string | null;
  details?: string | null;
  output_url?: string | null;
  source: string;
  raw?: unknown;
}

/** Insert a run; if external_id already exists for the agent, update it instead. */
export function recordRun(input: RunInput): { run: Run; created: boolean } {
  const raw = input.raw === undefined ? null : typeof input.raw === "string" ? input.raw : JSON.stringify(input.raw);
  if (input.external_id) {
    const existing = db
      .prepare("SELECT * FROM runs WHERE agent_id = ? AND external_id = ?")
      .get(input.agent_id, input.external_id) as Run | undefined;
    if (existing) {
      db.prepare(
        `UPDATE runs SET status=?, started_at=COALESCE(?, started_at), finished_at=COALESCE(?, finished_at),
         summary=COALESCE(?, summary), details=COALESCE(?, details), output_url=COALESCE(?, output_url), raw=COALESCE(?, raw)
         WHERE id=?`,
      ).run(
        input.status,
        input.started_at ?? null,
        input.finished_at ?? null,
        input.summary ?? null,
        input.details ?? null,
        input.output_url ?? null,
        raw,
        existing.id,
      );
      return { run: db.prepare("SELECT * FROM runs WHERE id = ?").get(existing.id) as Run, created: false };
    }
  }
  const res = db
    .prepare(
      `INSERT INTO runs (agent_id, external_id, status, started_at, finished_at, summary, details, output_url, source, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.agent_id,
      input.external_id ?? null,
      input.status,
      input.started_at ?? null,
      input.finished_at ?? null,
      input.summary ?? null,
      input.details ?? null,
      input.output_url ?? null,
      input.source,
      raw,
      now(),
    );
  return { run: db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(res.lastInsertRowid)) as Run, created: true };
}

export type RunRow = Run & { agent_name: string; platform: string; agent_native_url: string | null };

export function listRuns(opts: { limit?: number; agent_id?: number; status?: string; platform?: string } = {}): RunRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.agent_id) {
    where.push("r.agent_id = ?");
    params.push(opts.agent_id);
  }
  if (opts.status) {
    where.push("r.status = ?");
    params.push(opts.status);
  }
  if (opts.platform) {
    where.push("a.platform = ?");
    params.push(opts.platform);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return db
    .prepare(
      `SELECT r.*, a.name AS agent_name, a.platform AS platform, a.native_url AS agent_native_url
       FROM runs r JOIN agents a ON a.id = r.agent_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY COALESCE(r.finished_at, r.started_at, r.created_at) DESC LIMIT ?`,
    )
    .all(...params, limit) as RunRow[];
}

/* ---------- events ---------- */

export interface EventInput {
  platform?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  occurred_at?: string;
  dedupe_key?: string | null;
}

/** Returns the event, or null when dedupe_key already exists. */
export function addEvent(input: EventInput): EventRow | null {
  if (input.dedupe_key) {
    const dup = db.prepare("SELECT id FROM events WHERE dedupe_key = ?").get(input.dedupe_key);
    if (dup) return null;
  }
  const res = db
    .prepare(
      `INSERT INTO events (platform, kind, title, body, link, read, occurred_at, created_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      input.platform ?? null,
      input.kind,
      input.title,
      input.body ?? null,
      input.link ?? null,
      input.occurred_at ?? now(),
      now(),
      input.dedupe_key ?? null,
    );
  return db.prepare("SELECT * FROM events WHERE id = ?").get(Number(res.lastInsertRowid)) as EventRow;
}

export function listEvents(opts: { limit?: number; unread?: boolean; platform?: string } = {}): EventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.unread) where.push("read = 0");
  if (opts.platform) {
    where.push("platform = ?");
    params.push(opts.platform);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return db
    .prepare(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY occurred_at DESC LIMIT ?`)
    .all(...params, limit) as EventRow[];
}

export function markEventRead(id: number, read = true) {
  return db.prepare("UPDATE events SET read = ? WHERE id = ?").run(read ? 1 : 0, id).changes > 0;
}
export function markAllEventsRead() {
  return db.prepare("UPDATE events SET read = 1 WHERE read = 0").run().changes;
}

/* ---------- platform state ---------- */

export function getPlatformState(platform: string): PlatformState {
  const row = db.prepare("SELECT * FROM platform_state WHERE platform = ?").get(platform) as PlatformState | undefined;
  return (
    row ?? {
      platform,
      session_status: "unknown",
      last_sync_at: null,
      last_ok_at: null,
      last_error: null,
      screenshot_path: null,
      meta: null,
    }
  );
}

export function setPlatformState(platform: string, patch: Partial<Omit<PlatformState, "platform">>) {
  const cur = getPlatformState(platform);
  const next: PlatformState = { ...cur, ...patch, platform };
  db.prepare(
    `INSERT INTO platform_state (platform, session_status, last_sync_at, last_ok_at, last_error, screenshot_path, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET session_status=excluded.session_status, last_sync_at=excluded.last_sync_at,
       last_ok_at=excluded.last_ok_at, last_error=excluded.last_error, screenshot_path=excluded.screenshot_path, meta=excluded.meta`,
  ).run(platform, next.session_status, next.last_sync_at, next.last_ok_at, next.last_error, next.screenshot_path, next.meta);
  return next;
}

export function allPlatformStates(): PlatformState[] {
  return db.prepare("SELECT * FROM platform_state").all() as PlatformState[];
}

/* ---------- captures ---------- */

export function addCapture(c: { platform: string; url: string; method: string; status: number; content_type: string; body: string }) {
  const MAX = 512 * 1024;
  const body = c.body.length > MAX ? c.body.slice(0, MAX) : c.body;
  db.prepare(
    `INSERT INTO captures (platform, url, method, status, content_type, body, size, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.platform, c.url, c.method, c.status, c.content_type, body, c.body.length, now());
}

export function pruneCaptures(platform: string, keep = 300) {
  db.prepare(
    `DELETE FROM captures WHERE platform = ? AND id NOT IN (SELECT id FROM captures WHERE platform = ? ORDER BY id DESC LIMIT ?)`,
  ).run(platform, platform, keep);
}

export interface CaptureSummary {
  id: number;
  url: string;
  method: string;
  status: number;
  content_type: string;
  size: number;
  captured_at: string;
}

export function listCaptures(platform: string, limit = 100): CaptureSummary[] {
  return db
    .prepare(`SELECT id, url, method, status, content_type, size, captured_at FROM captures WHERE platform = ? ORDER BY id DESC LIMIT ?`)
    .all(platform, limit) as CaptureSummary[];
}

export function getCapture(id: number): (CaptureSummary & { platform: string; body: string }) | undefined {
  return db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as (CaptureSummary & { platform: string; body: string }) | undefined;
}

/* ---------- sync log ---------- */

export function startSyncLog(platform: string): number {
  const res = db.prepare("INSERT INTO sync_log (platform, started_at) VALUES (?, ?)").run(platform, now());
  return Number(res.lastInsertRowid);
}
export function finishSyncLog(id: number, r: { ok: boolean; message?: string; agents?: number; runs?: number; captures?: number }) {
  db.prepare(`UPDATE sync_log SET finished_at=?, ok=?, message=?, agents_found=?, runs_found=?, captures=? WHERE id=?`).run(
    now(),
    r.ok ? 1 : 0,
    r.message ?? null,
    r.agents ?? 0,
    r.runs ?? 0,
    r.captures ?? 0,
    id,
  );
}
export function recentSyncLogs(limit = 30) {
  return db.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT ?").all(limit);
}

/* ---------- settings ---------- */

export function getSetting(key: string): string | undefined {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value;
}
export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/* ---------- overview ---------- */

export function overviewCounts() {
  const agents = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE enabled = 1").get() as { n: number };
  const failed = db
    .prepare(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('failed','needs_attention') AND created_at > datetime('now', '-7 days')`)
    .get() as { n: number };
  const unread = db.prepare("SELECT COUNT(*) AS n FROM events WHERE read = 0").get() as { n: number };
  const runs24h = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE created_at > datetime('now', '-1 day')`).get() as { n: number };
  return { agents: agents.n, failed7d: failed.n, unreadEvents: unread.n, runs24h: runs24h.n };
}

export function asSessionStatus(s: string): SessionStatus {
  return (["logged_in", "needs_login", "unknown", "error"] as const).includes(s as SessionStatus) ? (s as SessionStatus) : "unknown";
}
