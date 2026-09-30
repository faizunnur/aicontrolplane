import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunResult, SqlDriver } from "./driver.js";

/*
  The SQLite engine: the original store, kept for the existing single-container deployments
  and local development until the Postgres cutover completes (it is dropped when the queue
  arrives — leases and the outbox are Postgres-only). Its historical migration chain lives
  here verbatim; Postgres starts from its own baseline in pg.ts.
*/

const now = () => new Date().toISOString();

export function openSqlite(dbPath: string): { driver: SqlDriver; raw: Database.Database } {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  baseline(db);
  migrate(db);
  db.pragma("foreign_keys = ON");

  const stmts = new Map<string, Database.Statement>();
  const prep = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };

  // One connection means one transaction at a time: an interleaved statement from another
  // async task would silently join (and its failure roll back) an open BEGIN. Transactions
  // therefore take a promise mutex, statements inside fn recognise their own transaction via
  // an ALS flag, and plain statements from anywhere else queue behind the open bracket.
  const inTx = new AsyncLocalStorage<true>();
  let txDone: Promise<void> = Promise.resolve();
  // A timer scheduled inside a transaction inherits its async context after the COMMIT, so
  // membership means the flag AND an actually-open transaction, never the flag alone.
  const inOwnTx = () => !!inTx.getStore() && db.inTransaction;
  const barrier = () => (inOwnTx() ? Promise.resolve() : txDone);

  const driver: SqlDriver = {
    kind: "sqlite",
    async all<T>(sql: string, params: unknown[] = []) {
      await barrier();
      return prep(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      // better-sqlite3 refuses .get() on statements that return no rows (plain INSERT/UPDATE);
      // those come through run(). Statements with RETURNING report reads=true and work here.
      await barrier();
      return prep(sql).get(...params) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      await barrier();
      const res = prep(sql).run(...params);
      return { changes: res.changes };
    },
    async exec(sql: string) {
      await barrier();
      db.exec(sql);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (inOwnTx()) return fn(); // nested: join the open transaction
      const prev = txDone;
      let release!: () => void;
      txDone = new Promise((r) => (release = r));
      await prev;
      try {
        db.exec("BEGIN");
        try {
          const out = await inTx.run(true, fn);
          db.exec("COMMIT");
          return out;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* already rolled back */
          }
          throw err;
        }
      } finally {
        release();
      }
    },
    async schemaVersion() {
      return db.prepare("SELECT id, name, applied_at FROM schema_migrations ORDER BY id").all() as { id: number; name: string; applied_at: string }[];
    },
    async close() {
      db.close();
    },
  };
  return { driver, raw: db };
}

/* ------------------------------------------------------------------------------------------
   Baseline schema, as the first release created it. Kept verbatim so every database, new or
   old, takes the same road through the migrations below. Never edit this block; add a migration.
------------------------------------------------------------------------------------------ */
function baseline(db: Database.Database) {
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
}

const hasTable = (db: Database.Database, name: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (db: Database.Database, table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
/** Additive column migration. */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/* ------------------------------------------------------------------------------------------
   Migrations. Each runs once, in order, inside a transaction, with foreign keys off so tables
   can be rebuilt. Only ever append; never edit an applied migration.
------------------------------------------------------------------------------------------ */
const MIGRATIONS: { id: number; name: string; up: (db: Database.Database) => void }[] = [
  {
    id: 1,
    name: "earlier additive columns and conversations",
    up: (db) => {
      ensureColumn(db, "agents", "keywords", "keywords TEXT");
      ensureColumn(db, "agents", "delivery", "delivery TEXT");
      ensureColumn(db, "messages", "platform", "platform TEXT");
      ensureColumn(db, "messages", "conversation_id", "conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE");
      ensureColumn(db, "messages", "steps", "steps TEXT");
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
    up: (db) => {
      // The registry always held tasks (a ChatGPT scheduled task, a Claude routine, a custom job); name it so.
      if (hasTable(db, "agents") && !hasTable(db, "tasks")) db.exec("ALTER TABLE agents RENAME TO tasks");

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
      ensureColumn(db, "tasks", "agent_id", "agent_id INTEGER REFERENCES agent_profiles(id) ON DELETE SET NULL");

      // Runs: no longer bound to a task, and carrying what kind of work they were.
      if (!hasColumn(db, "runs", "kind")) {
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
      if (hasColumn(db, "messages", "agent_id") && !hasColumn(db, "messages", "task_id")) db.exec("ALTER TABLE messages RENAME COLUMN agent_id TO task_id");
      ensureColumn(db, "messages", "run_id", "run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL");

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
    up: (db) => {
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
    up: (db) => {
      ensureColumn(db, "tasks", "prompt", "prompt TEXT");
      ensureColumn(db, "tasks", "next_run", "next_run TEXT");
      ensureColumn(db, "tasks", "configuration", "configuration TEXT");
    },
  },
  {
    id: 5,
    name: "login sessions",
    up: (db) => {
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
  {
    id: 6,
    name: "pairing codes for sign-in from your computer",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pairings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        token_hash TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'waiting',
        detail TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        paired_at TEXT,
        finished_at TEXT,
        ip TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS pairings_platform ON pairings(platform, id DESC)");
    },
  },
  {
    id: 7,
    name: "browser session state moves into the database (sealed)",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        blob TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    },
  },
  {
    id: 8,
    name: "durable execution: idempotency, leases, cancellation, checkpoints",
    up: (db) => {
      ensureColumn(db, "runs", "idempotency_key", "idempotency_key TEXT");
      ensureColumn(db, "runs", "attempt", "attempt INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "runs", "max_attempts", "max_attempts INTEGER");
      ensureColumn(db, "runs", "locked_by", "locked_by TEXT");
      ensureColumn(db, "runs", "lease_expires_at", "lease_expires_at TEXT");
      ensureColumn(db, "runs", "cancel_requested", "cancel_requested INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "runs", "priority", "priority INTEGER");
      ensureColumn(db, "runs", "queued_at", "queued_at TEXT");
      ensureColumn(db, "runs", "checkpoint", "checkpoint TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL");
    },
  },
  {
    id: 9,
    name: "outbox: the durable, ordered log of announced changes",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT
      )`);
    },
  },
  {
    id: 10,
    name: "browser ops: interactive browser work requested by one process, done by another",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS browser_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      )`);
    },
  },
  {
    id: 11,
    name: "real user accounts; sessions know whose they are",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      )`);
      ensureColumn(db, "sessions", "user_id", "user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
      // The single admin password becomes the first owner. Its legacy hash keeps working
      // (sha256: prefix) and upgrades to argon2 on the next successful login.
      const legacy = db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get() as { value: string } | undefined;
      const none = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
      if (legacy && none) {
        const ts = now();
        db.prepare("INSERT INTO users (email, password_hash, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)").run("admin@local", `sha256:${legacy.value}`, ts, ts);
      }
    },
  },
  {
    id: 12,
    name: "workspaces: orgs, per-org uniqueness, account verification",
    up: (db) => {
      // SQLite installs stay a single workspace (org 1) — sign-up needs Postgres — but they
      // run the same org-scoped SQL, so every tenant table gains org_id and the uniqueness
      // that must be per-workspace becomes composite. SQLite cannot alter a primary key, so
      // the affected tables are rebuilt (create new → copy → drop old → rename); the old
      // single-column uniques must go with them or composite upserts would still trip on
      // them. foreign_keys is OFF for the whole migration run.
      db.exec(`CREATE TABLE IF NOT EXISTS orgs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'default',
        quotas TEXT,
        created_at TEXT NOT NULL
      )`);
      db.prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (1, 'Default', ?)").run(now());

      db.exec(`CREATE TABLE settings_new (
        key TEXT NOT NULL,
        org_id INTEGER NOT NULL DEFAULT 1,
        value TEXT NOT NULL,
        PRIMARY KEY (org_id, key)
      )`);
      db.exec("INSERT INTO settings_new (key, org_id, value) SELECT key, 1, value FROM settings");
      db.exec("DROP TABLE settings");
      db.exec("ALTER TABLE settings_new RENAME TO settings");

      db.exec(`CREATE TABLE policies_new (
        action TEXT NOT NULL,
        org_id INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, action)
      )`);
      db.exec("INSERT INTO policies_new (action, org_id, mode, updated_at) SELECT action, 1, mode, updated_at FROM policies");
      db.exec("DROP TABLE policies");
      db.exec("ALTER TABLE policies_new RENAME TO policies");

      db.exec(`CREATE TABLE platform_state_new (
        platform TEXT NOT NULL,
        org_id INTEGER NOT NULL DEFAULT 1,
        session_status TEXT NOT NULL DEFAULT 'unknown',
        last_sync_at TEXT,
        last_ok_at TEXT,
        last_error TEXT,
        screenshot_path TEXT,
        meta TEXT,
        PRIMARY KEY (org_id, platform)
      )`);
      db.exec("INSERT INTO platform_state_new (platform, org_id, session_status, last_sync_at, last_ok_at, last_error, screenshot_path, meta) SELECT platform, 1, session_status, last_sync_at, last_ok_at, last_error, screenshot_path, meta FROM platform_state");
      db.exec("DROP TABLE platform_state");
      db.exec("ALTER TABLE platform_state_new RENAME TO platform_state");

      db.exec(`CREATE TABLE browser_sessions_new (
        id TEXT NOT NULL,
        org_id INTEGER NOT NULL DEFAULT 1,
        blob TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, id)
      )`);
      db.exec("INSERT INTO browser_sessions_new (id, org_id, blob, updated_at) SELECT id, 1, blob, updated_at FROM browser_sessions");
      db.exec("DROP TABLE browser_sessions");
      db.exec("ALTER TABLE browser_sessions_new RENAME TO browser_sessions");

      db.exec(`CREATE TABLE agent_profiles_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL DEFAULT 1,
        key TEXT NOT NULL,
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
      db.exec("INSERT INTO agent_profiles_new (id, org_id, key, name, description, provider_id, kind, capabilities, status, configuration, created_at, updated_at) SELECT id, 1, key, name, description, provider_id, kind, capabilities, status, configuration, created_at, updated_at FROM agent_profiles");
      db.exec("DROP TABLE agent_profiles");
      db.exec("ALTER TABLE agent_profiles_new RENAME TO agent_profiles");
      db.exec("CREATE UNIQUE INDEX agent_profiles_org_key ON agent_profiles(org_id, key)");

      db.exec(`CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL DEFAULT 1,
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
        keywords TEXT,
        delivery TEXT,
        agent_id INTEGER REFERENCES agent_profiles(id) ON DELETE SET NULL,
        prompt TEXT,
        next_run TEXT,
        configuration TEXT,
        UNIQUE(org_id, platform, key)
      )`);
      db.exec("INSERT INTO tasks_new (id, org_id, platform, key, name, source, purpose, schedule, native_url, status, enabled, meta, created_at, updated_at, keywords, delivery, agent_id, prompt, next_run, configuration) SELECT id, 1, platform, key, name, source, purpose, schedule, native_url, status, enabled, meta, created_at, updated_at, keywords, delivery, agent_id, prompt, next_run, configuration FROM tasks");
      db.exec("DROP TABLE tasks");
      db.exec("ALTER TABLE tasks_new RENAME TO tasks");

      db.exec(`CREATE TABLE events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL DEFAULT 1,
        platform TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        link TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dedupe_key TEXT
      )`);
      db.exec("INSERT INTO events_new (id, org_id, platform, kind, title, body, link, read, occurred_at, created_at, dedupe_key) SELECT id, 1, platform, kind, title, body, link, read, occurred_at, created_at, dedupe_key FROM events");
      db.exec("DROP TABLE events");
      db.exec("ALTER TABLE events_new RENAME TO events");
      db.exec("CREATE UNIQUE INDEX events_org_dedupe ON events(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL");

      // The rest only need the column (their ids stay globally unique).
      for (const t of ["messages", "runs", "run_events", "captures", "sync_log", "approvals", "audit_log", "sessions", "pairings", "conversations", "outbox", "browser_ops", "users"]) {
        ensureColumn(db, t, "org_id", "org_id INTEGER NOT NULL DEFAULT 1");
      }
      db.exec("DROP INDEX IF EXISTS runs_idempotency");
      db.exec("CREATE UNIQUE INDEX runs_idempotency ON runs(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
      db.exec("CREATE INDEX IF NOT EXISTS outbox_org_id ON outbox(org_id, id)");

      // Accounts that exist predate verification; they must not be locked out.
      ensureColumn(db, "users", "verified_at", "verified_at TEXT");
      db.prepare("UPDATE users SET verified_at = ? WHERE verified_at IS NULL").run(now());
      db.exec(`CREATE TABLE IF NOT EXISTS user_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )`);
    },
  },
  {
    id: 13,
    name: "list indexes, the run's current step, provider claims",
    up: (db) => {
      ensureColumn(db, "runs", "current_step", "current_step TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS runs_org_task_created ON runs(org_id, task_id, created_at DESC, id DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS events_org_occurred ON events(org_id, occurred_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS run_events_org_id ON run_events(org_id, id DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS audit_org_id ON audit_log(org_id, id DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS outbox_created ON outbox(created_at)");
      db.exec(`CREATE TABLE IF NOT EXISTS provider_claims (
        org_id INTEGER NOT NULL,
        platform_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (org_id, platform_id)
      )`);
    },
  },
  {
    id: 14,
    name: "ingest tokens stored hashed, looked up by index",
    up: (db) => {
      // The token is a bearer credential; at rest it becomes its sha256, and the lookup
      // hashes its input. Values that already look hashed (64 hex) are left alone, so
      // re-runs and half-migrated installs converge.
      const rows = db.prepare("SELECT org_id, value FROM settings WHERE key = 'ingest_token'").all() as { org_id: number; value: string }[];
      for (const r of rows) {
        if (/^[0-9a-f]{64}$/.test(r.value)) continue;
        db.prepare("UPDATE settings SET value = ? WHERE key = 'ingest_token' AND org_id = ?").run(createHash("sha256").update(r.value).digest("hex"), r.org_id);
      }
      db.exec("CREATE INDEX IF NOT EXISTS settings_key_value ON settings(key, value)");
    },
  },
  {
    id: 15,
    name: "desktop devices: the connectors that run a workspace's browser on its owner's computer",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL DEFAULT 1,
        user_id INTEGER,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        os TEXT,
        app_version TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS devices_org ON devices(org_id, id)");
    },
  },
];

function migrate(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (!pending.length) return;
  db.pragma("foreign_keys = OFF");
  try {
    for (const m of pending) {
      db.transaction(() => {
        m.up(db);
        db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, now());
      })();
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
