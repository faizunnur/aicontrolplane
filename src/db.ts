import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { bus } from "./bus.js";
import { config } from "./config.js";
import type {
  AgentDelivery,
  AgentProfile,
  Approval,
  ApprovalStatus,
  AuditEntry,
  Conversation,
  PolicyMode,
  DeliveryMode,
  EventRow,
  MessageRow,
  MessageStatus,
  PlatformState,
  Run,
  RunEvent,
  RunEventType,
  RunKind,
  RunStatus,
  RunTrigger,
  SessionStatus,
  Step,
  StepStatus,
  Task,
  TaskSource,
} from "./types.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

/* ------------------------------------------------------------------------------------------
   Baseline schema, as the first release created it. Kept verbatim so every database, new or
   old, takes the same road through the migrations below. Never edit this block; add a migration.
------------------------------------------------------------------------------------------ */
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
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_assignment',
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  suggestions TEXT,
  routing TEXT,
  delivery_mode TEXT,
  delivered_at TEXT,
  acked_at TEXT,
  response TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_status ON messages(status, created_at DESC);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);
`);

export const now = () => new Date().toISOString();

const hasTable = (name: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
/** Additive column migration. */
function ensureColumn(table: string, column: string, ddl: string) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/* ------------------------------------------------------------------------------------------
   Migrations. Each runs once, in order, inside a transaction, with foreign keys off so tables
   can be rebuilt. Only ever append; never edit an applied migration.
------------------------------------------------------------------------------------------ */
const MIGRATIONS: { id: number; name: string; up: () => void }[] = [
  {
    id: 1,
    name: "earlier additive columns and conversations",
    up: () => {
      ensureColumn("agents", "keywords", "keywords TEXT");
      ensureColumn("agents", "delivery", "delivery TEXT");
      ensureColumn("messages", "platform", "platform TEXT");
      ensureColumn("messages", "conversation_id", "conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE");
      ensureColumn("messages", "steps", "steps TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at)");
      // Messages written before conversations existed are gathered into one thread so nothing disappears.
      const orphans = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id IS NULL").get() as { n: number }).n;
      if (orphans > 0) {
        const ts = now();
        const res = db.prepare("INSERT INTO conversations (title, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?)").run("Earlier messages", ts, ts, ts);
        db.prepare("UPDATE messages SET conversation_id = ? WHERE conversation_id IS NULL").run(Number(res.lastInsertRowid));
      }
    },
  },
  {
    id: 2,
    name: "tasks, runs of every kind, run events, agent profiles",
    up: () => {
      // The registry always held tasks (a ChatGPT scheduled task, a Claude routine, a custom job); name it so.
      if (hasTable("agents") && !hasTable("tasks")) db.exec("ALTER TABLE agents RENAME TO tasks");

      db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        provider_id TEXT,
        kind TEXT NOT NULL DEFAULT 'custom',
        capabilities TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        configuration TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      ensureColumn("tasks", "agent_id", "agent_id INTEGER REFERENCES agent_profiles(id) ON DELETE SET NULL");

      // Runs: no longer bound to a task, and carrying what kind of work they were.
      if (!hasColumn("runs", "kind")) {
        db.exec(`CREATE TABLE runs_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id INTEGER REFERENCES agent_profiles(id) ON DELETE SET NULL,
          provider TEXT,
          kind TEXT NOT NULL DEFAULT 'external',
          trigger TEXT,
          message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          label TEXT,
          external_id TEXT,
          status TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          summary TEXT,
          details TEXT,
          output_url TEXT,
          error TEXT,
          source TEXT NOT NULL,
          raw TEXT,
          created_at TEXT NOT NULL
        )`);
        db.exec(`INSERT INTO runs_migrated (id, task_id, provider, kind, trigger, label, external_id, status, started_at, finished_at, summary, details, output_url, source, raw, created_at)
          SELECT r.id, r.agent_id, t.platform,
            CASE r.source WHEN 'collector' THEN 'discovered' WHEN 'email' THEN 'email' ELSE 'external' END,
            CASE r.source WHEN 'collector' THEN 'schedule' WHEN 'email' THEN 'push' ELSE 'push' END,
            t.name, r.external_id, r.status, r.started_at, r.finished_at, r.summary, r.details, r.output_url, r.source, r.raw, r.created_at
          FROM runs r LEFT JOIN tasks t ON t.id = r.agent_id`);
        db.exec("DROP TABLE runs");
        db.exec("ALTER TABLE runs_migrated RENAME TO runs");
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_task_external ON runs(task_id, external_id) WHERE external_id IS NOT NULL");
      db.exec("CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS runs_status ON runs(status)");
      db.exec("CREATE INDEX IF NOT EXISTS runs_message ON runs(message_id)");

      // Messages point at the task they were handed to and at the run that carried them out.
      if (hasColumn("messages", "agent_id") && !hasColumn("messages", "task_id")) db.exec("ALTER TABLE messages RENAME COLUMN agent_id TO task_id");
      ensureColumn("messages", "run_id", "run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL");

      // The canonical execution timeline.
      db.exec(`CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        key TEXT,
        label TEXT NOT NULL,
        status TEXT,
        detail TEXT,
        metadata TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id)");
    },
  },
  {
    id: 3,
    name: "approval policies, persisted approvals, audit log",
    up: () => {
      db.exec(`CREATE TABLE IF NOT EXISTS policies (
        action TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        provider TEXT,
        summary TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        reason TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, requested_at DESC)");
      db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        metadata TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at DESC)");
    },
  },
  {
    id: 4,
    name: "task prompt, next run and configuration",
    up: () => {
      ensureColumn("tasks", "prompt", "prompt TEXT");
      ensureColumn("tasks", "next_run", "next_run TEXT");
      ensureColumn("tasks", "configuration", "configuration TEXT");
    },
  },
  {
    id: 5,
    name: "login sessions",
    up: () => {
      db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT,
        ip TEXT
      )`);
    },
  },
];

function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (!pending.length) return;
  db.pragma("foreign_keys = OFF");
  try {
    for (const m of pending) {
      db.transaction(() => {
        m.up();
        db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, now());
      })();
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
migrate();
db.pragma("foreign_keys = ON");

/** Applied schema migrations, newest last. */
export function schemaVersion() {
  return db.prepare("SELECT id, name, applied_at FROM schema_migrations ORDER BY id").all() as { id: number; name: string; applied_at: string }[];
}

/* ---------- tasks (the registry: standing work at a provider) ---------- */

export interface TaskInput {
  platform: string;
  key: string;
  /** Falls back to key on insert; left unchanged on update when omitted. */
  name?: string;
  source?: TaskSource;
  purpose?: string | null;
  schedule?: string | null;
  native_url?: string | null;
  status?: string | null;
  enabled?: boolean;
  meta?: unknown;
  keywords?: string | null;
  delivery?: AgentDelivery | null;
  agent_id?: number | null;
  prompt?: string | null;
  next_run?: string | null;
  configuration?: Record<string, unknown> | null;
}

export type TaskWithLastRun = Task & { last_run?: Run | null };

export function listTasks(opts: { platform?: string; agent_id?: number; includeDisabled?: boolean; limit?: number } = {}): TaskWithLastRun[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.platform) {
    where.push("t.platform = ?");
    params.push(opts.platform);
  }
  if (opts.agent_id) {
    where.push("t.agent_id = ?");
    params.push(opts.agent_id);
  }
  if (!opts.includeDisabled) where.push("t.enabled = 1");
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const sql = `SELECT t.* FROM tasks t ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.platform, t.name LIMIT ?`;
  const tasks = db.prepare(sql).all(...params, limit) as Task[];
  const lastRun = db.prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC LIMIT 1`);
  return tasks.map((t) => ({ ...t, last_run: (lastRun.get(t.id) as Run | undefined) ?? null }));
}

export function getTask(id: number): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

export function findTask(platform: string, key: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE platform = ? AND key = ?").get(platform, key) as Task | undefined;
}

/** Insert or update by (platform, key). Fields that are undefined are left untouched on update. */
export function upsertTask(input: TaskInput): Task {
  const existing = findTask(input.platform, input.key);
  const ts = now();
  const meta = input.meta === undefined ? undefined : JSON.stringify(input.meta);
  const conf = input.configuration === undefined ? undefined : input.configuration === null ? null : JSON.stringify(input.configuration);
  if (existing) {
    db.prepare(
      `UPDATE tasks SET
         name = COALESCE(?, name),
         source = COALESCE(?, source),
         purpose = COALESCE(?, purpose),
         schedule = COALESCE(?, schedule),
         native_url = COALESCE(?, native_url),
         status = COALESCE(?, status),
         enabled = COALESCE(?, enabled),
         meta = COALESCE(?, meta),
         keywords = COALESCE(?, keywords),
         delivery = COALESCE(?, delivery),
         agent_id = COALESCE(?, agent_id),
         prompt = COALESCE(?, prompt),
         next_run = COALESCE(?, next_run),
         configuration = COALESCE(?, configuration),
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
      input.keywords ?? null,
      input.delivery === undefined || input.delivery === null ? null : JSON.stringify(input.delivery),
      input.agent_id ?? null,
      input.prompt ?? null,
      input.next_run ?? null,
      conf ?? null,
      ts,
      existing.id,
    );
    const t = getTask(existing.id)!;
    bus.emit("task", t);
    return t;
  }
  const res = db
    .prepare(
      `INSERT INTO tasks (platform, key, name, source, purpose, schedule, native_url, status, enabled, meta, keywords, delivery, agent_id, prompt, next_run, configuration, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.keywords ?? null,
      input.delivery ? JSON.stringify(input.delivery) : null,
      input.agent_id ?? null,
      input.prompt ?? null,
      input.next_run ?? null,
      conf ?? null,
      ts,
      ts,
    );
  const t = getTask(Number(res.lastInsertRowid))!;
  bus.emit("task", t);
  return t;
}

export function updateTask(id: number, patch: Partial<TaskInput>): Task | undefined {
  const t = getTask(id);
  if (!t) return undefined;
  db.prepare(
    `UPDATE tasks SET name=?, purpose=?, schedule=?, native_url=?, status=?, enabled=?, meta=?, platform=?, key=?, keywords=?, delivery=?, agent_id=?, prompt=?, next_run=?, configuration=?, updated_at=? WHERE id=?`,
  ).run(
    patch.name ?? t.name,
    patch.purpose === undefined ? t.purpose : patch.purpose,
    patch.schedule === undefined ? t.schedule : patch.schedule,
    patch.native_url === undefined ? t.native_url : patch.native_url,
    patch.status === undefined ? t.status : patch.status,
    patch.enabled === undefined ? t.enabled : patch.enabled ? 1 : 0,
    patch.meta === undefined ? t.meta : JSON.stringify(patch.meta),
    patch.platform ?? t.platform,
    patch.key ?? t.key,
    patch.keywords === undefined ? t.keywords : patch.keywords,
    patch.delivery === undefined ? t.delivery : patch.delivery === null ? null : JSON.stringify(patch.delivery),
    patch.agent_id === undefined ? t.agent_id : patch.agent_id,
    patch.prompt === undefined ? t.prompt : patch.prompt,
    patch.next_run === undefined ? t.next_run : patch.next_run,
    patch.configuration === undefined ? t.configuration : patch.configuration === null ? null : JSON.stringify(patch.configuration),
    now(),
    id,
  );
  const next = getTask(id);
  if (next) bus.emit("task", next);
  return next;
}

export function deleteTask(id: number): boolean {
  const ok = db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  if (ok) bus.emit("task:deleted", { id });
  return ok;
}

/* ---------- runs (one row per execution, whatever kind) ---------- */

export interface RecordRunInput {
  task_id: number | null;
  external_id?: string | null;
  status: RunStatus;
  kind?: RunKind;
  provider?: string | null;
  trigger?: RunTrigger | null;
  label?: string | null;
  agent_id?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  summary?: string | null;
  details?: string | null;
  output_url?: string | null;
  error?: string | null;
  source: string;
  raw?: unknown;
}

/**
 * Record a run reported from outside (pushed by an agent, captured from a provider, read from
 * email). If external_id already exists for the task, the row is updated instead.
 */
export function recordRun(input: RecordRunInput): { run: Run; created: boolean } {
  const raw = input.raw === undefined ? null : typeof input.raw === "string" ? input.raw : JSON.stringify(input.raw);
  const task = input.task_id ? getTask(input.task_id) : undefined;
  const provider = input.provider ?? task?.platform ?? null;
  const label = input.label ?? task?.name ?? null;
  if (input.external_id && input.task_id) {
    const existing = db.prepare("SELECT * FROM runs WHERE task_id = ? AND external_id = ?").get(input.task_id, input.external_id) as Run | undefined;
    if (existing) {
      db.prepare(
        `UPDATE runs SET status=?, started_at=COALESCE(?, started_at), finished_at=COALESCE(?, finished_at),
         summary=COALESCE(?, summary), details=COALESCE(?, details), output_url=COALESCE(?, output_url), error=COALESCE(?, error), raw=COALESCE(?, raw)
         WHERE id=?`,
      ).run(input.status, input.started_at ?? null, input.finished_at ?? null, input.summary ?? null, input.details ?? null, input.output_url ?? null, input.error ?? null, raw, existing.id);
      const run = getRun(existing.id)!;
      bus.emit("run", run);
      return { run, created: false };
    }
  }
  const res = db
    .prepare(
      `INSERT INTO runs (task_id, agent_id, provider, kind, trigger, message_id, label, external_id, status, started_at, finished_at, summary, details, output_url, error, source, raw, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.task_id,
      input.agent_id ?? task?.agent_id ?? null,
      provider,
      input.kind ?? "external",
      input.trigger ?? "push",
      label,
      input.external_id ?? null,
      input.status,
      input.started_at ?? null,
      input.finished_at ?? null,
      input.summary ?? null,
      input.details ?? null,
      input.output_url ?? null,
      input.error ?? null,
      input.source,
      raw,
      now(),
    );
  const run = getRun(Number(res.lastInsertRowid))!;
  bus.emit("run", run);
  return { run, created: true };
}

export interface StartRunInput {
  kind: RunKind;
  label: string;
  provider?: string | null;
  task_id?: number | null;
  agent_id?: number | null;
  message_id?: number | null;
  trigger?: RunTrigger;
  source?: string;
}

/** Begin a run the control plane executes itself. It is "running" until finishRun. */
export function startRun(input: StartRunInput): Run {
  const ts = now();
  const task = input.task_id ? getTask(input.task_id) : undefined;
  const res = db
    .prepare(
      `INSERT INTO runs (task_id, agent_id, provider, kind, trigger, message_id, label, external_id, status, started_at, finished_at, summary, details, output_url, error, source, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'running', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?)`,
    )
    .run(input.task_id ?? null, input.agent_id ?? task?.agent_id ?? null, input.provider ?? task?.platform ?? null, input.kind, input.trigger ?? "user", input.message_id ?? null, input.label, ts, input.source ?? "control-plane", ts);
  const run = getRun(Number(res.lastInsertRowid))!;
  if (input.message_id) db.prepare("UPDATE messages SET run_id = ? WHERE id = ?").run(run.id, input.message_id);
  bus.emit("run", run);
  return run;
}

export function finishRun(id: number, patch: { status: RunStatus; summary?: string | null; error?: string | null; output_url?: string | null; details?: string | null; external_id?: string | null }): Run | undefined {
  const r = getRun(id);
  if (!r) return undefined;
  db.prepare(`UPDATE runs SET status=?, finished_at=?, summary=?, error=?, output_url=?, details=?, external_id=? WHERE id=?`).run(
    patch.status,
    now(),
    patch.summary === undefined ? r.summary : patch.summary,
    patch.error === undefined ? r.error : patch.error,
    patch.output_url === undefined ? r.output_url : patch.output_url,
    patch.details === undefined ? r.details : patch.details,
    patch.external_id === undefined ? r.external_id : patch.external_id,
    id,
  );
  const run = getRun(id)!;
  bus.emit("run", run);
  return run;
}

export function getRun(id: number): Run | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Run | undefined;
}

export type RunRow = Run & { task_name: string | null; task_key: string | null; task_native_url: string | null; agent_name: string | null };

const RUN_SELECT = `SELECT r.*, t.name AS task_name, t.key AS task_key, t.native_url AS task_native_url, a.name AS agent_name
  FROM runs r LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN agent_profiles a ON a.id = r.agent_id`;

export function listRuns(opts: { limit?: number; task_id?: number; status?: string | string[]; platform?: string; kind?: string; agent_id?: number; since?: string; message_id?: number } = {}): RunRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.task_id) {
    where.push("r.task_id = ?");
    params.push(opts.task_id);
  }
  if (opts.agent_id) {
    where.push("r.agent_id = ?");
    params.push(opts.agent_id);
  }
  if (opts.message_id) {
    where.push("r.message_id = ?");
    params.push(opts.message_id);
  }
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`r.status IN (${list.map(() => "?").join(",")})`);
    params.push(...list);
  }
  if (opts.platform) {
    where.push("r.provider = ?");
    params.push(opts.platform);
  }
  if (opts.kind) {
    where.push("r.kind = ?");
    params.push(opts.kind);
  }
  if (opts.since) {
    where.push("COALESCE(r.finished_at, r.started_at, r.created_at) >= ?");
    params.push(opts.since);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return db
    .prepare(`${RUN_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(r.finished_at, r.started_at, r.created_at) DESC LIMIT ?`)
    .all(...params, limit) as RunRow[];
}

/* ---------- run events (the timeline) ---------- */

export interface RunEventInput {
  type: RunEventType;
  label: string;
  key?: string | null;
  status?: StepStatus | null;
  detail?: string | null;
  metadata?: unknown;
  at?: string;
}

export function addRunEvent(runId: number, input: RunEventInput): RunEvent {
  const res = db
    .prepare(`INSERT INTO run_events (run_id, at, type, key, label, status, detail, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, input.at ?? now(), input.type, input.key ?? null, input.label, input.status ?? null, input.detail ?? null, input.metadata === undefined ? null : JSON.stringify(input.metadata));
  const ev = db.prepare("SELECT * FROM run_events WHERE id = ?").get(Number(res.lastInsertRowid)) as RunEvent;
  bus.emit("run-event", ev);
  return ev;
}

export function runEvents(runId: number): RunEvent[] {
  return db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id").all(runId) as RunEvent[];
}

export type ActivityRow = RunEvent & { run_label: string | null; run_kind: RunKind; provider: string | null; agent_id: number | null; agent_name: string | null; task_id: number | null; run_status: RunStatus };

/** The newest timeline lines across every run: the unified activity feed. */
export function recentRunEvents(opts: { limit?: number; since?: string; provider?: string; agent_id?: number; run_id?: number } = {}): ActivityRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.since) {
    where.push("e.at >= ?");
    params.push(opts.since);
  }
  if (opts.provider) {
    where.push("r.provider = ?");
    params.push(opts.provider);
  }
  if (opts.agent_id) {
    where.push("r.agent_id = ?");
    params.push(opts.agent_id);
  }
  if (opts.run_id) {
    where.push("e.run_id = ?");
    params.push(opts.run_id);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  return db
    .prepare(
      `SELECT e.*, r.label AS run_label, r.kind AS run_kind, r.provider, r.agent_id, a.name AS agent_name, r.task_id, r.status AS run_status
       FROM run_events e JOIN runs r ON r.id = e.run_id LEFT JOIN agent_profiles a ON a.id = r.agent_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.id DESC LIMIT ?`,
    )
    .all(...params, limit) as ActivityRow[];
}

/** The step a running run is on right now, for lists that show many runs at once. */
export function currentStepOf(runId: number): { label: string; status: StepStatus; at: string } | null {
  const steps = foldSteps(runEvents(runId));
  const live = [...steps].reverse().find((s) => s.status === "running" || s.status === "waiting");
  const s = live ?? steps.at(-1);
  return s ? { label: s.label, status: s.status, at: s.at } : null;
}

/** The step view of a timeline: one entry per key, in first-seen order, carrying its latest state. */
export function foldSteps(events: RunEvent[]): Step[] {
  const out: Step[] = [];
  const byKey = new Map<string, Step>();
  for (const ev of events) {
    if (ev.type !== "step" || !ev.key) continue;
    const status = (ev.status ?? "running") as StepStatus;
    const finished = status === "done" || status === "failed" || status === "skipped";
    const cur = byKey.get(ev.key);
    if (!cur) {
      const s: Step = { key: ev.key, label: ev.label, status, detail: ev.detail ?? null, at: ev.at, ended_at: finished ? ev.at : null };
      byKey.set(ev.key, s);
      out.push(s);
    } else {
      cur.label = ev.label || cur.label;
      cur.status = status;
      if (ev.detail !== null && ev.detail !== undefined) cur.detail = ev.detail;
      if (status === "running" && cur.status !== "running") cur.at = ev.at;
      cur.ended_at = finished ? ev.at : null;
    }
  }
  return out;
}

/* ---------- events (notifications) ---------- */

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
    .prepare(`INSERT INTO events (platform, kind, title, body, link, read, occurred_at, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(input.platform ?? null, input.kind, input.title, input.body ?? null, input.link ?? null, input.occurred_at ?? now(), now(), input.dedupe_key ?? null);
  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(res.lastInsertRowid)) as EventRow;
  bus.emit("notification", ev);
  return ev;
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
  return db.prepare(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY occurred_at DESC LIMIT ?`).all(...params, limit) as EventRow[];
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
  return row ?? { platform, session_status: "unknown", last_sync_at: null, last_ok_at: null, last_error: null, screenshot_path: null, meta: null };
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
  bus.emit("platform:row", platform);
  return next;
}

export function allPlatformStates(): PlatformState[] {
  return db.prepare("SELECT * FROM platform_state").all() as PlatformState[];
}

/* ---------- captures ---------- */

export function addCapture(c: { platform: string; url: string; method: string; status: number; content_type: string; body: string }) {
  const MAX = 512 * 1024;
  const body = c.body.length > MAX ? c.body.slice(0, MAX) : c.body;
  db.prepare(`INSERT INTO captures (platform, url, method, status, content_type, body, size, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(c.platform, c.url, c.method, c.status, c.content_type, body, c.body.length, now());
}

export function pruneCaptures(platform: string, keep = 300) {
  db.prepare(`DELETE FROM captures WHERE platform = ? AND id NOT IN (SELECT id FROM captures WHERE platform = ? ORDER BY id DESC LIMIT ?)`).run(platform, platform, keep);
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
  return db.prepare(`SELECT id, url, method, status, content_type, size, captured_at FROM captures WHERE platform = ? ORDER BY id DESC LIMIT ?`).all(platform, limit) as CaptureSummary[];
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
  db.prepare(`UPDATE sync_log SET finished_at=?, ok=?, message=?, agents_found=?, runs_found=?, captures=? WHERE id=?`).run(now(), r.ok ? 1 : 0, r.message ?? null, r.agents ?? 0, r.runs ?? 0, r.captures ?? 0, id);
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

/* ---------- agent profiles (who does the work) ---------- */

export interface AgentProfileInput {
  key: string;
  /** Falls back to key on insert; left unchanged on update when omitted. */
  name?: string;
  description?: string | null;
  provider_id?: string | null;
  kind?: AgentProfile["kind"];
  capabilities?: string[] | null;
  status?: AgentProfile["status"];
  configuration?: unknown;
}

export type AgentProfileSummary = AgentProfile & { task_count: number; last_run_at: string | null; running: number };

const AGENT_SELECT = `SELECT a.*,
  (SELECT COUNT(*) FROM tasks t WHERE t.agent_id = a.id AND t.enabled = 1) AS task_count,
  (SELECT MAX(COALESCE(r.finished_at, r.started_at, r.created_at)) FROM runs r WHERE r.agent_id = a.id) AS last_run_at,
  (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id AND r.status = 'running') AS running
  FROM agent_profiles a`;

export function listAgentProfiles(opts: { provider?: string; kind?: string; includeDisabled?: boolean } = {}): AgentProfileSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.provider) {
    where.push("a.provider_id = ?");
    params.push(opts.provider);
  }
  if (opts.kind) {
    where.push("a.kind = ?");
    params.push(opts.kind);
  }
  if (!opts.includeDisabled) where.push("a.status != 'disabled'");
  return db.prepare(`${AGENT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.kind, a.name`).all(...params) as AgentProfileSummary[];
}

export function getAgentProfile(id: number): AgentProfileSummary | undefined {
  return db.prepare(`${AGENT_SELECT} WHERE a.id = ?`).get(id) as AgentProfileSummary | undefined;
}

export function findAgentProfile(key: string): AgentProfileSummary | undefined {
  return db.prepare(`${AGENT_SELECT} WHERE a.key = ?`).get(key) as AgentProfileSummary | undefined;
}

/** Insert or update by key. Fields that are undefined are left untouched on update. */
export function upsertAgentProfile(input: AgentProfileInput): AgentProfileSummary {
  const existing = findAgentProfile(input.key);
  const ts = now();
  const caps = input.capabilities === undefined ? undefined : input.capabilities === null ? null : JSON.stringify(input.capabilities);
  const conf = input.configuration === undefined ? undefined : input.configuration === null ? null : JSON.stringify(input.configuration);
  if (existing) {
    db.prepare(
      `UPDATE agent_profiles SET name = COALESCE(?, name), description = COALESCE(?, description), provider_id = COALESCE(?, provider_id), kind = COALESCE(?, kind),
         capabilities = COALESCE(?, capabilities), status = COALESCE(?, status), configuration = COALESCE(?, configuration), updated_at = ? WHERE id = ?`,
    ).run(input.name ?? null, input.description ?? null, input.provider_id ?? null, input.kind ?? null, caps ?? null, input.status ?? null, conf ?? null, ts, existing.id);
    const a = getAgentProfile(existing.id)!;
    bus.emit("agent", a);
    return a;
  }
  const res = db
    .prepare(`INSERT INTO agent_profiles (key, name, description, provider_id, kind, capabilities, status, configuration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.key, input.name ?? input.key, input.description ?? null, input.provider_id ?? null, input.kind ?? "custom", caps ?? null, input.status ?? "active", conf ?? null, ts, ts);
  const a = getAgentProfile(Number(res.lastInsertRowid))!;
  bus.emit("agent", a);
  return a;
}

export function updateAgentProfile(id: number, patch: Partial<AgentProfileInput>): AgentProfileSummary | undefined {
  const a = getAgentProfile(id);
  if (!a) return undefined;
  db.prepare(`UPDATE agent_profiles SET name=?, description=?, provider_id=?, kind=?, capabilities=?, status=?, configuration=?, updated_at=? WHERE id=?`).run(
    patch.name ?? a.name,
    patch.description === undefined ? a.description : patch.description,
    patch.provider_id === undefined ? a.provider_id : patch.provider_id,
    patch.kind ?? a.kind,
    patch.capabilities === undefined ? a.capabilities : patch.capabilities === null ? null : JSON.stringify(patch.capabilities),
    patch.status ?? a.status,
    patch.configuration === undefined ? a.configuration : patch.configuration === null ? null : JSON.stringify(patch.configuration),
    now(),
    id,
  );
  const next = getAgentProfile(id);
  if (next) bus.emit("agent", next);
  return next;
}

export function deleteAgentProfile(id: number): boolean {
  const ok = db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(id).changes > 0;
  if (ok) bus.emit("agent:deleted", { id });
  return ok;
}

/* ---------- policies, approvals, audit ---------- */

export function getPolicyOverrides(): Record<string, PolicyMode> {
  const out: Record<string, PolicyMode> = {};
  for (const r of db.prepare("SELECT action, mode FROM policies").all() as { action: string; mode: PolicyMode }[]) out[r.action] = r.mode;
  return out;
}
export function setPolicyOverride(action: string, mode: PolicyMode | null) {
  if (mode === null) db.prepare("DELETE FROM policies WHERE action = ?").run(action);
  else db.prepare("INSERT INTO policies (action, mode, updated_at) VALUES (?, ?, ?) ON CONFLICT(action) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at").run(action, mode, now());
}

export type ApprovalRow = Approval & { run_label: string | null; run_kind: string | null };
const APPROVAL_SELECT = `SELECT a.*, r.label AS run_label, r.kind AS run_kind FROM approvals a LEFT JOIN runs r ON r.id = a.run_id`;

export function createApproval(input: { run_id?: number | null; message_id?: number | null; action: string; provider?: string | null; summary: string; detail?: string | null }): ApprovalRow {
  const res = db
    .prepare(`INSERT INTO approvals (run_id, message_id, action, provider, summary, detail, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(input.run_id ?? null, input.message_id ?? null, input.action, input.provider ?? null, input.summary, input.detail ?? null, now());
  const a = getApproval(Number(res.lastInsertRowid))!;
  bus.emit("approval", a);
  return a;
}
export function getApproval(id: number): ApprovalRow | undefined {
  return db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRow | undefined;
}
export function updateApproval(id: number, patch: { status: ApprovalStatus; decided_by?: string | null; reason?: string | null }): ApprovalRow | undefined {
  const a = getApproval(id);
  if (!a) return undefined;
  db.prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ?").run(patch.status, patch.status === "pending" ? null : now(), patch.decided_by ?? a.decided_by, patch.reason ?? a.reason, id);
  const next = getApproval(id)!;
  bus.emit("approval", next);
  return next;
}
export function listApprovals(opts: { status?: ApprovalStatus | ApprovalStatus[]; message_id?: number; run_id?: number; limit?: number } = {}): ApprovalRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`a.status IN (${list.map(() => "?").join(",")})`);
    params.push(...list);
  }
  if (opts.message_id) {
    where.push("a.message_id = ?");
    params.push(opts.message_id);
  }
  if (opts.run_id) {
    where.push("a.run_id = ?");
    params.push(opts.run_id);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return db.prepare(`${APPROVAL_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.requested_at DESC LIMIT ?`).all(...params, limit) as ApprovalRow[];
}

export function addAudit(input: { actor: string; action: string; target?: string | null; detail?: string | null; metadata?: unknown }): AuditEntry {
  const res = db.prepare("INSERT INTO audit_log (at, actor, action, target, detail, metadata) VALUES (?, ?, ?, ?, ?, ?)").run(now(), input.actor, input.action, input.target ?? null, input.detail ?? null, input.metadata === undefined ? null : JSON.stringify(input.metadata));
  return db.prepare("SELECT * FROM audit_log WHERE id = ?").get(Number(res.lastInsertRowid)) as AuditEntry;
}
export function listAudit(opts: { limit?: number; action?: string } = {}): AuditEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  if (opts.action) return db.prepare("SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id DESC LIMIT ?").all(opts.action + "%", limit) as AuditEntry[];
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as AuditEntry[];
}

/* ---------- login sessions ---------- */

export interface SessionRow {
  id: number;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
}

export function insertSession(input: { token_hash: string; expires_at: string; user_agent?: string | null; ip?: string | null }): SessionRow {
  const ts = now();
  const res = db.prepare("INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)").run(input.token_hash, ts, ts, input.expires_at, input.user_agent ?? null, input.ip ?? null);
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(Number(res.lastInsertRowid)) as SessionRow;
}
export function findSession(tokenHash: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash, now()) as SessionRow | undefined;
}
export function touchSession(id: number) {
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now(), id);
}
export function deleteSession(tokenHash: string): boolean {
  return db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash).changes > 0;
}
export function deleteAllSessions(): number {
  return db.prepare("DELETE FROM sessions").run().changes;
}
export function purgeExpiredSessions(): number {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now()).changes;
}
export function countSessions(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?").get(now()) as { n: number }).n;
}

/* ---------- overview ---------- */

export function overviewCounts() {
  const tasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE enabled = 1").get() as { n: number };
  const failed = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('failed','needs_attention') AND COALESCE(finished_at, started_at, created_at) > datetime('now', '-7 days')`).get() as { n: number };
  const unread = db.prepare("SELECT COUNT(*) AS n FROM events WHERE read = 0").get() as { n: number };
  const runs24h = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE COALESCE(finished_at, started_at, created_at) > datetime('now', '-1 day')`).get() as { n: number };
  return { agents: tasks.n, tasks: tasks.n, failed7d: failed.n, unreadEvents: unread.n, runs24h: runs24h.n };
}

export function asSessionStatus(s: string): SessionStatus {
  return (["logged_in", "needs_login", "unknown", "error"] as const).includes(s as SessionStatus) ? (s as SessionStatus) : "unknown";
}

/* ---------- conversations (threads in the chat panel) ---------- */

export type ConversationSummary = Conversation & {
  message_count: number;
  last_status: MessageStatus | null;
  last_text: string | null;
  last_platform: string | null;
  /** True while any message in the thread is still being worked on. */
  active: number;
};

const CONVERSATION_SELECT = `SELECT c.*,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
  (SELECT status FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_status,
  (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
  (SELECT platform FROM messages m WHERE m.conversation_id = c.id AND m.platform IS NOT NULL ORDER BY m.created_at DESC LIMIT 1) AS last_platform,
  EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.status IN ('assigned','delivered')) AS active
  FROM conversations c`;

export function createConversation(title = ""): ConversationSummary {
  const ts = now();
  const res = db.prepare("INSERT INTO conversations (title, created_at, updated_at, last_message_at) VALUES (?, ?, ?, NULL)").run(title.slice(0, 120), ts, ts);
  const c = getConversation(Number(res.lastInsertRowid))!;
  bus.emit("conversation", { action: "created", conversation: c });
  return c;
}

export function getConversation(id: number): ConversationSummary | undefined {
  return db.prepare(`${CONVERSATION_SELECT} WHERE c.id = ?`).get(id) as ConversationSummary | undefined;
}

export function listConversations(limit = 200): ConversationSummary[] {
  return db.prepare(`${CONVERSATION_SELECT} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 1000)) as ConversationSummary[];
}

export function updateConversation(id: number, patch: { title?: string; last_message_at?: string }): ConversationSummary | undefined {
  const c = getConversation(id);
  if (!c) return undefined;
  db.prepare("UPDATE conversations SET title = ?, last_message_at = ?, updated_at = ? WHERE id = ?").run(
    patch.title === undefined ? c.title : patch.title.slice(0, 120),
    patch.last_message_at === undefined ? c.last_message_at : patch.last_message_at,
    now(),
    id,
  );
  const next = getConversation(id)!;
  bus.emit("conversation", { action: "updated", conversation: next });
  return next;
}

export function deleteConversation(id: number): boolean {
  const c = getConversation(id);
  if (!c) return false;
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  bus.emit("conversation", { action: "deleted", conversation: c });
  return true;
}

/** Messages of one thread, oldest first. */
export function conversationMessages(conversationId: number, limit = 300): MessageWithTask[] {
  return db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ORDER BY m.created_at ASC, m.id ASC LIMIT ?`).all(conversationId, Math.min(Math.max(limit, 1), 2000)) as MessageWithTask[];
}

/* ---------- messages (what you typed; each one may point at a run) ---------- */

export type MessageWithTask = MessageRow & { task_name: string | null; task_platform: string | null; task_key: string | null; task_native_url: string | null };
/** @deprecated use MessageWithTask. */
export type MessageWithAgent = MessageWithTask;

const MESSAGE_SELECT = `SELECT m.*, t.name AS task_name, t.platform AS task_platform, t.key AS task_key, t.native_url AS task_native_url
  FROM messages m LEFT JOIN tasks t ON t.id = m.task_id`;

export function createMessage(text: string, conversationId: number | null = null): MessageRow {
  const ts = now();
  const res = db.prepare(`INSERT INTO messages (text, status, conversation_id, created_at, updated_at) VALUES (?, 'needs_assignment', ?, ?, ?)`).run(text, conversationId, ts, ts);
  if (conversationId) {
    db.prepare("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, conversationId);
    const c = getConversation(conversationId);
    if (c) bus.emit("conversation", { action: "updated", conversation: c });
  }
  const m = getMessage(Number(res.lastInsertRowid))!;
  bus.emit("message:row", m);
  return m;
}

export function getMessage(id: number): MessageWithTask | undefined {
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageWithTask | undefined;
}

export interface MessagePatch {
  status?: MessageStatus;
  platform?: string | null;
  task_id?: number | null;
  run_id?: number | null;
  suggestions?: unknown;
  routing?: unknown;
  delivery_mode?: DeliveryMode | null;
  delivered_at?: string | null;
  acked_at?: string | null;
  response?: string | null;
  error?: string | null;
  steps?: Step[] | null;
}

export function updateMessage(id: number, patch: MessagePatch): MessageWithTask | undefined {
  const m = getMessage(id);
  if (!m) return undefined;
  const json = (v: unknown, cur: string | null) => (v === undefined ? cur : v === null ? null : JSON.stringify(v));
  db.prepare(
    `UPDATE messages SET status=?, platform=?, task_id=?, run_id=?, suggestions=?, routing=?, delivery_mode=?, delivered_at=?, acked_at=?, response=?, error=?, steps=?, updated_at=? WHERE id=?`,
  ).run(
    patch.status ?? m.status,
    patch.platform === undefined ? m.platform : patch.platform,
    patch.task_id === undefined ? m.task_id : patch.task_id,
    patch.run_id === undefined ? m.run_id : patch.run_id,
    json(patch.suggestions, m.suggestions),
    json(patch.routing, m.routing),
    patch.delivery_mode === undefined ? m.delivery_mode : patch.delivery_mode,
    patch.delivered_at === undefined ? m.delivered_at : patch.delivered_at,
    patch.acked_at === undefined ? m.acked_at : patch.acked_at,
    patch.response === undefined ? m.response : patch.response,
    patch.error === undefined ? m.error : patch.error,
    json(patch.steps, m.steps),
    now(),
    id,
  );
  const next = getMessage(id);
  if (next) {
    bus.emit("message:row", next);
    // A status change is what the thread list cares about (running dot, last status).
    if (next.conversation_id && patch.status && patch.status !== m.status) {
      const c = getConversation(next.conversation_id);
      if (c) bus.emit("conversation", { action: "updated", conversation: c });
    }
  }
  return next;
}

export function listMessages(opts: { status?: string; task_id?: number; limit?: number } = {}): MessageWithTask[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push("m.status = ?");
    params.push(opts.status);
  }
  if (opts.task_id) {
    where.push("m.task_id = ?");
    params.push(opts.task_id);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return db.prepare(`${MESSAGE_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.created_at DESC LIMIT ?`).all(...params, limit) as MessageWithTask[];
}

/** Messages waiting for a task's agent that pulls its instructions. */
export function inboxFor(taskId: number): MessageWithTask[] {
  return db.prepare(`${MESSAGE_SELECT} WHERE m.task_id = ? AND m.delivery_mode = 'inbox' AND m.status IN ('assigned','delivered') ORDER BY m.created_at ASC`).all(taskId) as MessageWithTask[];
}

export function deleteMessage(id: number): boolean {
  const m = getMessage(id);
  const ok = db.prepare("DELETE FROM messages WHERE id = ?").run(id).changes > 0;
  if (ok && m) {
    bus.emit("message:deleted", { id, conversation_id: m.conversation_id });
    if (m.conversation_id) {
      const c = getConversation(m.conversation_id);
      if (c) bus.emit("conversation", { action: "updated", conversation: c });
    }
  }
  return ok;
}

export function openMessageCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status IN ('needs_assignment','failed')`).get() as { n: number }).n;
}

/* ---------- stats ---------- */

export interface DayStat {
  day: string;
  success: number;
  failed: number;
  needs_attention: number;
  running: number;
  cancelled: number;
  unknown: number;
}

/** Runs per day for the last N days, bucketed by status. Days with no runs are included as zeros. */
export function runStats(days = 14): DayStat[] {
  const n = Math.min(Math.max(days, 1), 90);
  const rows = db
    .prepare(`SELECT substr(COALESCE(finished_at, started_at, created_at), 1, 10) AS day, status, COUNT(*) AS n FROM runs WHERE COALESCE(finished_at, started_at, created_at) >= date('now', ?) GROUP BY day, status`)
    .all(`-${n - 1} days`) as { day: string; status: string; n: number }[];
  const out: DayStat[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const stat: DayStat = { day, success: 0, failed: 0, needs_attention: 0, running: 0, cancelled: 0, unknown: 0 };
    for (const r of rows) if (r.day === day && r.status in stat) (stat as unknown as Record<string, number>)[r.status] += r.n;
    out.push(stat);
  }
  return out;
}

/** Last few run statuses per task, newest first, for the history dots on the tasks table. */
export function recentStatusesByTask(limit = 6): Record<number, string[]> {
  const rows = db
    .prepare(`SELECT task_id, status FROM (SELECT task_id, status, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY COALESCE(finished_at, started_at, created_at) DESC) AS rn FROM runs WHERE task_id IS NOT NULL) WHERE rn <= ?`)
    .all(limit) as { task_id: number; status: string }[];
  const out: Record<number, string[]> = {};
  for (const r of rows) (out[r.task_id] ??= []).push(r.status);
  return out;
}
