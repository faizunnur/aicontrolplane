import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type Database from "better-sqlite3";
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
} from "../../core/src/index.js";
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "../../core/src/index.js";
import { currentOrgId, enterOrgScope, scopeStore, systemScope, withOrg } from "../../core/src/scope.js";
import type { SqlDriver } from "./driver.js";
import { openSqlite } from "./sqlite.js";
import { openPg } from "./pg.js";

/*
  The data layer. It owns the database and every query; nothing else in the codebase touches
  SQL. The seams that matter:
    - initData() wires it up: the caller says where rows live (SQLite file or Postgres URL)
      and how to announce changes. The layer knows nothing about config files or the bus.
    - notify() is called for every row change worth announcing. Today the app forwards it to
      the in-process bus; later it becomes the transactional outbox write.
    - every function goes through the SqlDriver, so the two engines run the same SQL. The
      conformance for that is the unit suite executed against both drivers in CI.
*/

/** How the data layer announces a change (topic, payload, outbox id, workspace). Wired in initData. */
export type Notify = (topic: string, payload: unknown, outboxId?: number, orgId?: number) => void;

let q: SqlDriver;
/** The raw SQLite handle — only in sqlite mode, only for the legacy file-mirror backup. */
export let db: Database.Database | undefined;
let _notify: Notify = () => {};
let _seal: ((value: string) => Promise<string>) | null = null;

/** Keys inside task configuration/delivery whose values are credentials, sealed at rest. */
const SECRET_TASK_KEYS = new Set(["fire_token", "webhook_token"]);
async function sealSecretsIn<T extends Record<string, unknown> | null | undefined>(obj: T): Promise<T> {
  if (!obj || !_seal) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (SECRET_TASK_KEYS.has(k) && typeof v === "string" && v && !v.startsWith("enc1:")) out[k] = await _seal(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = await sealSecretsIn(v as Record<string, unknown>);
  }
  return out as T;
}
/* ---------- the workspace (org) scope ----------
   Which workspace a query belongs to rides an AsyncLocalStorage, entered at the edges (an
   authenticated request, a queue job adopting its row's org, a boot path that is org 1 by
   definition). Tenant queries fail closed: no scope, no rows. Cross-workspace maintenance
   (reapers, sweeps, prunes) runs under systemScope and uses the *All variants, adopting each
   row's org before touching it. */

// The scope itself lives in packages/core (no database behind it) so browser code can enter
// it in a process that has no database; this layer re-exports it and enforces it.
export { currentOrgId, systemScope, withOrg };
/** The ambient workspace. Throws when none is in scope: a leak-by-default is never an option. */
function oid(): number {
  const sc = scopeStore();
  if (!sc) {
    // Unit tests drive this layer directly and node:test re-enters its own async scope, so an
    // ALS entered at file top level never reaches the callbacks. The spawned-server e2e suite
    // does NOT set this, so fail-closed stays proven where it matters: end to end. A stray
    // env var must never open this door in production.
    const t = process.env.ACP_TEST_DEFAULT_ORG;
    if (t && process.env.NODE_ENV !== "production") return Number(t);
    throw new Error("tenant query outside a workspace scope (wrap the caller in withOrg)");
  }
  if ("system" in sc) throw new Error("tenant query under systemScope: use the *All variant and adopt the row's org");
  return sc.orgId;
}
function assertSystem(): void {
  const sc = scopeStore();
  if (!sc || !("system" in sc)) throw new Error("this cross-workspace query must run under systemScope");
}
/** Test-only: scope the rest of the current async context (node --test files run top-level). */
export function enterOrgScopeForTests(orgId: number): void {
  enterOrgScope(orgId);
}

/**
 * Every announced change is first appended to the outbox — the durable, ordered event log
 * with a monotonic id (the replay cursor for reconnecting clients, and what a relay tails
 * to carry events across instances) — then handed to the wired announcer (the in-process
 * bus today). A log append failing must never break the write it describes, but it is
 * never silent either: the failure is logged and the bus still hears the event (without a
 * replay cursor). published_at stays NULL on insert; nothing publishes downstream yet.
 */
type OutboxEntry = { topic: string; payload: unknown; orgId: number };
const OUTBOX_FLUSH_MS = 20;
const OUTBOX_FLUSH_COUNT = 100;
const OUTBOX_BUFFER_MAX = 5000;
const outboxBuffer: OutboxEntry[] = [];
let outboxTimer: NodeJS.Timeout | null = null;
let outboxChain: Promise<void> = Promise.resolve();

const notify: Notify = (topic, payload) => {
  // The org is captured HERE, synchronously: the flush runs outside the caller's scope.
  // Announcements from org-less paths (boot, maintenance) belong to the founding workspace.
  // Buffered entries flush as one batched insert — every ~20ms, or sooner when enough pile
  // up — and flushes are chained, so ids keep the write order (an inversion, finish logged
  // before start, would corrupt every reconnecting client's view).
  const orgId = currentOrgId() ?? 1;
  outboxBuffer.push({ topic, payload, orgId });
  if (outboxBuffer.length > OUTBOX_BUFFER_MAX) {
    // A consumer this far behind cannot be replayed to honestly; drop the oldest and tell
    // each affected workspace's clients to refetch instead of trusting the stream.
    const dropped = outboxBuffer.splice(0, outboxBuffer.length - OUTBOX_BUFFER_MAX);
    console.warn(`[data] outbox buffer overflow: dropped ${dropped.length} oldest entr${dropped.length === 1 ? "y" : "ies"}`);
    for (const org of new Set(dropped.map((e) => e.orgId))) {
      try {
        _notify("resync", { org }, undefined, org);
      } catch {
        /* an announcement failing must never break the write it announces */
      }
    }
  }
  if (outboxBuffer.length >= OUTBOX_FLUSH_COUNT) {
    if (outboxTimer) {
      clearTimeout(outboxTimer);
      outboxTimer = null;
    }
    queueOutboxFlush();
  } else if (!outboxTimer) {
    outboxTimer = setTimeout(() => {
      outboxTimer = null;
      queueOutboxFlush();
    }, OUTBOX_FLUSH_MS);
    outboxTimer.unref?.(); // a pending flush must not keep a test or a draining process alive
  }
};

function queueOutboxFlush(): void {
  outboxChain = outboxChain.then(flushOutboxBuffer);
}

async function flushOutboxBuffer(): Promise<void> {
  while (outboxBuffer.length) {
    const batch = outboxBuffer.splice(0, OUTBOX_FLUSH_COUNT);
    const rows = batch.map((e) => {
      let body: string | null = null;
      try {
        body = e.payload === undefined ? null : JSON.stringify(e.payload);
      } catch {
        body = null;
      }
      return { ...e, body };
    });
    // Insert the whole batch in one statement (pg) or one transaction (sqlite); either way
    // each entry learns its own id, in order — outbox ids ARE the SSE replay cursor.
    let ids: (number | undefined)[] = rows.map(() => undefined);
    const ts = now();
    try {
      if (!q) throw new Error("data layer not initialised");
      if (q.kind === "pg") {
        const placeholders = rows.map(() => "(?, ?, ?, ?)").join(", ");
        const params = rows.flatMap((r) => [r.orgId, r.topic, r.body, ts]);
        const returned = await q.all<{ id: number }>(`INSERT INTO outbox (org_id, topic, payload, created_at) VALUES ${placeholders} RETURNING id`, params);
        ids = returned.map((r) => r.id).sort((a, b) => a - b);
      } else {
        ids = await q.transaction(async () => {
          const out: number[] = [];
          for (const r of rows) out.push((await q.get<{ id: number }>("INSERT INTO outbox (org_id, topic, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id", [r.orgId, r.topic, r.body, ts]))!.id);
          return out;
        });
      }
    } catch (err) {
      console.error("[data] outbox append failed; events emitted without replay ids:", err instanceof Error ? err.message : err);
    }
    for (let i = 0; i < rows.length; i++) {
      try {
        _notify(rows[i].topic, rows[i].payload, ids[i], rows[i].orgId);
      } catch {
        /* an announcement failing must never break the write it announces */
      }
    }
  }
}

/** Settles once every announcement queued so far has been logged and emitted (tests, shutdown drains). */
export async function flushNotifications(): Promise<void> {
  if (outboxTimer) {
    clearTimeout(outboxTimer);
    outboxTimer = null;
  }
  queueOutboxFlush();
  await outboxChain;
}

/** One workspace's outbox entries after a cursor, oldest first — the replay path for reconnecting consumers. */
export async function outboxAfter(orgId: number, id: number, limit = 500): Promise<{ id: number; topic: string; payload: string | null; created_at: string }[]> {
  return q.all("SELECT id, topic, payload, created_at FROM outbox WHERE org_id = ? AND id > ? ORDER BY id LIMIT ?", [orgId, id, Math.min(Math.max(limit, 1), 2000)]);
}

/** Trim the log; consumers further behind than this refetch state instead of replaying. */
export async function pruneOutbox(olderThanMs = 60 * 60_000): Promise<number> {
  return (await q.run("DELETE FROM outbox WHERE created_at < ?", [new Date(Date.now() - olderThanMs).toISOString()])).changes;
}

export function dataDriver(): "sqlite" | "pg" {
  return q.kind;
}

export interface InitDataOptions {
  /** SQLite file path; used when no databaseUrl selects Postgres. */
  dbPath: string;
  /** Postgres connection string; when set (and driver is not forced to sqlite) it is the source of truth. */
  databaseUrl?: string;
  /** Force an engine regardless of databaseUrl. */
  driver?: "sqlite" | "pg";
  notify?: Notify;
  /** Seals a secret value for storage (envelope encryption). Without it, secrets stay as given. */
  sealSecret?: (value: string) => Promise<string>;
}

/** Open the database, apply the schema, and wire the change announcer. Idempotent. */
export async function initData(opts: InitDataOptions): Promise<void> {
  if (q) {
    if (opts.notify) _notify = opts.notify;
    if (opts.sealSecret) _seal = opts.sealSecret;
    return;
  }
  const engine = opts.driver ?? (opts.databaseUrl ? "pg" : "sqlite");
  if (engine === "pg") {
    if (!opts.databaseUrl) throw new Error("DB driver is pg but no DATABASE_URL is set");
    q = (await openPg(opts.databaseUrl)).driver;
  } else {
    const opened = openSqlite(opts.dbPath);
    q = opened.driver;
    db = opened.raw;
  }
  if (opts.notify) _notify = opts.notify;
  if (opts.sealSecret) _seal = opts.sealSecret;
}

export async function closeData(): Promise<void> {
  await flushNotifications(); // the unref'd timer may still owe a flush
  if (q) await q.close();
}

export const now = () => new Date().toISOString();

/* ---------- workspaces (orgs) ---------- */

export interface OrgRow {
  id: number;
  name: string;
  plan: string;
  quotas: string | null;
  created_at: string;
}

/** Create a workspace. Part of sign-up, which starts before any workspace exists. */
export async function createOrg(input: { name: string }): Promise<OrgRow> {
  const row = await q.get<{ id: number }>("INSERT INTO orgs (name, created_at) VALUES (?, ?) RETURNING id", [input.name.slice(0, 120) || "Workspace", now()]);
  return (await q.get<OrgRow>("SELECT * FROM orgs WHERE id = ?", [row!.id]))!;
}
export async function getOrg(id: number): Promise<OrgRow | undefined> {
  return q.get<OrgRow>("SELECT * FROM orgs WHERE id = ?", [id]);
}

/** Applied schema migrations, newest last. SQLite runs 1..6; Postgres starts at 100. */
export async function schemaVersion(): Promise<{ id: number; name: string; applied_at: string }[]> {
  return q.schemaVersion();
}

/** Readiness probe: can the database answer a trivial query right now? Throws when it cannot. */
export async function dbReady(): Promise<void> {
  await q.get("SELECT 1");
}

/** Test-only escape hatches: one statement through the active driver, whatever the engine. */
export async function rawAll<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  return q.all<T>(sql, params);
}
export async function rawRun(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  return q.run(sql, params);
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

export async function listTasks(opts: { platform?: string; agent_id?: number; includeDisabled?: boolean; limit?: number } = {}): Promise<TaskWithLastRun[]> {
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
  where.push("t.org_id = ?");
  params.push(oid());
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const sql = `SELECT t.* FROM tasks t ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.platform, t.name LIMIT ?`;
  const tasks = await q.all<Task>(sql, [...params, limit]);
  if (!tasks.length) return [];
  // One window-function pass for every task's newest run, not a query per task. Newest by
  // (created_at, id), which the runs_org_task_created index serves directly.
  const lastRuns = await q.all<Run & { rn: number }>(
    `SELECT * FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.created_at DESC, r.id DESC) AS rn FROM runs r WHERE r.org_id = ? AND r.task_id IS NOT NULL) ranked WHERE rn = 1`,
    [oid()],
  );
  const byTask = new Map<number, Run>();
  for (const { rn: _rn, ...run } of lastRuns) byTask.set(run.task_id!, run as Run);
  return tasks.map((t) => ({ ...t, last_run: byTask.get(t.id) ?? null }));
}

export async function getTask(id: number): Promise<Task | undefined> {
  return q.get<Task>("SELECT * FROM tasks WHERE id = ? AND org_id = ?", [id, oid()]);
}

export async function findTask(platform: string, key: string): Promise<Task | undefined> {
  return q.get<Task>("SELECT * FROM tasks WHERE platform = ? AND key = ? AND org_id = ?", [platform, key, oid()]);
}

/** Insert or update by (platform, key). Fields that are undefined are left untouched on update. */
export async function upsertTask(input: TaskInput): Promise<Task> {
  const existing = await findTask(input.platform, input.key);
  const ts = now();
  const meta = input.meta === undefined ? undefined : JSON.stringify(input.meta);
  const conf = input.configuration === undefined ? undefined : input.configuration === null ? null : JSON.stringify(await sealSecretsIn(input.configuration));
  const sealedDelivery = input.delivery === undefined || input.delivery === null ? input.delivery : await sealSecretsIn(input.delivery as unknown as Record<string, unknown>);
  if (existing) {
    await q.run(
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
       WHERE id = ? AND org_id = ?`,
      [
        input.name ?? null,
        input.source ?? null,
        input.purpose ?? null,
        input.schedule ?? null,
        input.native_url ?? null,
        input.status ?? null,
        input.enabled === undefined ? null : input.enabled ? 1 : 0,
        meta ?? null,
        input.keywords ?? null,
        sealedDelivery === undefined || sealedDelivery === null ? null : JSON.stringify(sealedDelivery),
        input.agent_id ?? null,
        input.prompt ?? null,
        input.next_run ?? null,
        conf ?? null,
        ts,
        existing.id,
        oid(),
      ],
    );
    const t = (await getTask(existing.id))!;
    notify("task", t);
    return t;
  }
  let row: { id: number } | undefined;
  try {
    row = await q.get<{ id: number }>(
      `INSERT INTO tasks (org_id, platform, key, name, source, purpose, schedule, native_url, status, enabled, meta, keywords, delivery, agent_id, prompt, next_run, configuration, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        oid(),
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
        sealedDelivery ? JSON.stringify(sealedDelivery) : null,
        input.agent_id ?? null,
        input.prompt ?? null,
        input.next_run ?? null,
        conf ?? null,
        ts,
        ts,
      ],
    );
  } catch (err) {
    // Two simultaneous upserts of one (platform, key): the unique index lets one insert in;
    // the loser re-reads and takes the update path it would have taken a moment later.
    const raced = await findTask(input.platform, input.key);
    if (raced) return upsertTask(input);
    throw err;
  }
  const t = (await getTask(row!.id))!;
  notify("task", t);
  return t;
}

export async function updateTask(id: number, patch: Partial<TaskInput>): Promise<Task | undefined> {
  const t = await getTask(id);
  if (!t) return undefined;
  await q.run(
    `UPDATE tasks SET name=?, purpose=?, schedule=?, native_url=?, status=?, enabled=?, meta=?, platform=?, key=?, keywords=?, delivery=?, agent_id=?, prompt=?, next_run=?, configuration=?, updated_at=? WHERE id=? AND org_id=?`,
    [
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
      patch.delivery === undefined ? t.delivery : patch.delivery === null ? null : JSON.stringify(await sealSecretsIn(patch.delivery as unknown as Record<string, unknown>)),
      patch.agent_id === undefined ? t.agent_id : patch.agent_id,
      patch.prompt === undefined ? t.prompt : patch.prompt,
      patch.next_run === undefined ? t.next_run : patch.next_run,
      patch.configuration === undefined ? t.configuration : patch.configuration === null ? null : JSON.stringify(await sealSecretsIn(patch.configuration)),
      now(),
      id,
      oid(),
    ],
  );
  const next = await getTask(id);
  if (next) notify("task", next);
  return next;
}

export async function deleteTask(id: number): Promise<boolean> {
  const ok = (await q.run("DELETE FROM tasks WHERE id = ? AND org_id = ?", [id, oid()])).changes > 0;
  if (ok) notify("task:deleted", { id });
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
export async function recordRun(input: RecordRunInput): Promise<{ run: Run; created: boolean }> {
  const raw = input.raw === undefined ? null : typeof input.raw === "string" ? input.raw : JSON.stringify(input.raw);
  const task = input.task_id ? await getTask(input.task_id) : undefined;
  const provider = input.provider ?? task?.platform ?? null;
  const label = input.label ?? task?.name ?? null;
  if (input.external_id && input.task_id) {
    const existing = await q.get<Run>("SELECT * FROM runs WHERE task_id = ? AND external_id = ? AND org_id = ?", [input.task_id, input.external_id, oid()]);
    if (existing) {
      await q.run(
        `UPDATE runs SET status=?, started_at=COALESCE(?, started_at), finished_at=COALESCE(?, finished_at),
         summary=COALESCE(?, summary), details=COALESCE(?, details), output_url=COALESCE(?, output_url), error=COALESCE(?, error), raw=COALESCE(?, raw)
         WHERE id=?`,
        [input.status, input.started_at ?? null, input.finished_at ?? null, input.summary ?? null, input.details ?? null, input.output_url ?? null, input.error ?? null, raw, existing.id],
      );
      const run = (await getRun(existing.id))!;
      notify("run", run);
      return { run, created: false };
    }
  }
  let row: { id: number } | undefined;
  try {
    row = await q.get<{ id: number }>(
      `INSERT INTO runs (org_id, task_id, agent_id, provider, kind, trigger, message_id, label, external_id, status, started_at, finished_at, summary, details, output_url, error, source, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        oid(),
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
      ],
    );
  } catch (err) {
    // Two simultaneous reports of one (task, external_id): the unique index lets one insert
    // in; the loser re-reads and takes the update path it would have taken a moment later.
    if (input.external_id && input.task_id) {
      const raced = await q.get<Run>("SELECT id FROM runs WHERE task_id = ? AND external_id = ? AND org_id = ?", [input.task_id, input.external_id, oid()]);
      if (raced) return recordRun(input);
    }
    throw err;
  }
  const run = (await getRun(row!.id))!;
  notify("run", run);
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
  /** Same key, same run: a duplicate submission returns the existing row instead of a second execution. */
  idempotency_key?: string | null;
  priority?: number | null;
  /** "queued" when a worker will claim it; "running" (the default) when the caller executes now. */
  status?: "running" | "queued";
  /** Resume/execution inputs, stored from birth so any process can pick the run up. */
  checkpoint?: string | null;
}

/** Begin a run the control plane executes itself. It is "running" until finishRun. */
export async function startRun(input: StartRunInput): Promise<Run> {
  const ts = now();
  const task = input.task_id ? await getTask(input.task_id) : undefined;
  if (input.idempotency_key) {
    const existing = await findRunByIdempotencyKey(input.idempotency_key);
    if (existing) return existing;
  }
  const status = input.status ?? "running";
  let row: { id: number } | undefined;
  try {
    row = await q.get<{ id: number }>(
    `INSERT INTO runs (org_id, task_id, agent_id, provider, kind, trigger, message_id, label, external_id, status, started_at, finished_at, summary, details, output_url, error, source, raw, created_at, idempotency_key, priority, queued_at, checkpoint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?) RETURNING id`,
    [
      oid(),
      input.task_id ?? null,
      input.agent_id ?? task?.agent_id ?? null,
      input.provider ?? task?.platform ?? null,
      input.kind,
      input.trigger ?? "user",
      input.message_id ?? null,
      input.label,
      status,
      status === "running" ? ts : null,
      input.source ?? "control-plane",
      ts,
      input.idempotency_key ?? null,
      input.priority ?? null,
      ts,
      input.checkpoint ?? null,
    ],
  );
  } catch (err) {
    // Two simultaneous submissions with one key: the unique index lets one in; the loser
    // honours the contract and returns the winner's run instead of surfacing a 500.
    if (input.idempotency_key) {
      const existing = await findRunByIdempotencyKey(input.idempotency_key);
      if (existing) return existing;
    }
    throw err;
  }
  const run = (await getRun(row!.id))!;
  if (input.message_id) await q.run("UPDATE messages SET run_id = ? WHERE id = ? AND org_id = ?", [run.id, input.message_id, oid()]);
  notify("run", run);
  return run;
}

export async function finishRun(id: number, patch: { status: RunStatus; summary?: string | null; error?: string | null; output_url?: string | null; details?: string | null; external_id?: string | null }): Promise<Run | undefined> {
  const r = await getRun(id);
  if (!r) return undefined;
  // Guarded transition: only a running run can be finished. A run that already settled keeps
  // its outcome, whoever reports later (double finish, late webhook, restart recovery races).
  const res = await q.run(`UPDATE runs SET status=?, finished_at=?, summary=?, error=?, output_url=?, details=?, external_id=? WHERE id=? AND org_id=? AND status='running'`, [
    patch.status,
    now(),
    patch.summary === undefined ? r.summary : patch.summary,
    patch.error === undefined ? r.error : patch.error,
    patch.output_url === undefined ? r.output_url : patch.output_url,
    patch.details === undefined ? r.details : patch.details,
    patch.external_id === undefined ? r.external_id : patch.external_id,
    id,
    oid(),
  ]);
  if (res.changes === 0) return r;
  const run = (await getRun(id))!;
  notify("run", run);
  return run;
}

export async function getRun(id: number): Promise<Run | undefined> {
  return q.get<Run>("SELECT * FROM runs WHERE id = ? AND org_id = ?", [id, oid()]);
}

/** A run row wherever it lives — the org-adoption peek for queue-job entry points. */
export async function getRunAnyOrg(id: number): Promise<(Run & { org_id: number }) | undefined> {
  assertSystem();
  return q.get<Run & { org_id: number }>("SELECT * FROM runs WHERE id = ?", [id]);
}

/**
 * THE one writer of runs.status: a guarded single-statement transition. Returns the updated
 * row, or undefined when the run was not in any of the expected states (someone else moved
 * it first — the caller backs off, never overwrites). Legality against RUN_TRANSITIONS is
 * the caller's contract; the guard here makes races safe, the map makes intents reviewable.
 */
export async function transitionRun(
  id: number,
  from: readonly RunStatus[],
  to: RunStatus,
  patch: { summary?: string | null; error?: string | null; output_url?: string | null; details?: string | null; external_id?: string | null; checkpoint?: string | null; locked_by?: string | null; lease_expires_at?: string | null; attempt?: number; queued_at?: string | null; started_at?: string | null; finished?: boolean } = {},
): Promise<Run | undefined> {
  const sets: string[] = ["status = ?"];
  const params: unknown[] = [to];
  for (const k of ["summary", "error", "output_url", "details", "external_id", "checkpoint", "locked_by", "lease_expires_at", "attempt", "queued_at", "started_at"] as const) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      params.push(patch[k]);
    }
  }
  if (patch.finished ?? TERMINAL_RUN_STATUSES.includes(to)) sets.push("finished_at = ?"), params.push(now());
  const res = await q.run(`UPDATE runs SET ${sets.join(", ")} WHERE id = ? AND org_id = ? AND status IN (${from.map(() => "?").join(",")})`, [...params, id, oid(), ...from]);
  if (res.changes === 0) return undefined;
  const run = (await getRun(id))!;
  notify("run", run);
  return run;
}

/** Cooperative stop: flip the flag; the executing side checks it between steps. */
export async function setCancelRequested(id: number): Promise<void> {
  await q.run("UPDATE runs SET cancel_requested = 1 WHERE id = ? AND org_id = ?", [id, oid()]);
}
export async function cancelRequested(id: number): Promise<boolean> {
  return ((await q.get<{ cancel_requested: number }>("SELECT cancel_requested FROM runs WHERE id = ? AND org_id = ?", [id, oid()]))?.cancel_requested ?? 0) === 1;
}

/** A run already recorded under this idempotency key, if any. */
export async function findRunByIdempotencyKey(key: string): Promise<Run | undefined> {
  return q.get<Run>("SELECT * FROM runs WHERE idempotency_key = ? AND org_id = ?", [key, oid()]);
}

/** Queued/retrying runs nobody picked up since the cutoff, across every workspace — their job was lost; re-send it. */
export async function listStuckQueuedRunsAll(cutoffIso: string, limit = 100): Promise<(Run & { org_id: number })[]> {
  assertSystem();
  return q.all<Run & { org_id: number }>("SELECT * FROM runs WHERE status IN ('queued','retrying') AND COALESCE(queued_at, created_at) < ? LIMIT ?", [cutoffIso, limit]);
}

/**
 * Running runs with no sign of life since the cutoff: no timeline event and no start after
 * it. What the reaper fails — a crashed executor's leftovers, never a live run elsewhere.
 */
export async function listStaleRunningRunsAll(cutoffIso: string, limit = 100): Promise<(Run & { org_id: number })[]> {
  assertSystem();
  return q.all<Run & { org_id: number }>(
    `SELECT r.* FROM runs r
     WHERE r.status = 'running' AND r.kind != 'external'
       AND COALESCE((SELECT MAX(e.at) FROM run_events e WHERE e.run_id = r.id), r.started_at, r.created_at) < ?
     LIMIT ?`,
    [cutoffIso, limit],
  );
}

/** Attach the provider's own id to a run, so a later report with the same id updates it. */
export async function setRunExternalId(id: number, externalId: string): Promise<void> {
  await q.run("UPDATE runs SET external_id = ? WHERE id = ? AND org_id = ?", [externalId, id, oid()]);
}

/** Runs in a status across every workspace — the maintenance reconciler's worklist. */
export async function listRunsByStatusAll(status: RunStatus, limit = 200): Promise<(Run & { org_id: number })[]> {
  assertSystem();
  return q.all<Run & { org_id: number }>("SELECT * FROM runs WHERE status = ? LIMIT ?", [status, limit]);
}

export type RunRow = Run & { task_name: string | null; task_key: string | null; task_native_url: string | null; agent_name: string | null };

const RUN_SELECT = `SELECT r.*, t.name AS task_name, t.key AS task_key, t.native_url AS task_native_url, a.name AS agent_name
  FROM runs r LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN agent_profiles a ON a.id = r.agent_id`;

export async function listRuns(opts: { limit?: number; task_id?: number; status?: string | string[]; platform?: string; kind?: string; agent_id?: number; since?: string; message_id?: number } = {}): Promise<RunRow[]> {
  const where: string[] = ["r.org_id = ?"];
  const params: unknown[] = [oid()];
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
  // Newest by (created_at, id) rather than by COALESCE over three timestamps: the same list
  // for anything but long-lived backfills, and one the runs indexes can actually serve.
  return q.all<RunRow>(`${RUN_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`, [...params, limit]);
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

export async function addRunEvent(runId: number, input: RunEventInput): Promise<RunEvent> {
  const row = await q.get<{ id: number }>(`INSERT INTO run_events (org_id, run_id, at, type, key, label, status, detail, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
    oid(),
    runId,
    input.at ?? now(),
    input.type,
    input.key ?? null,
    input.label,
    input.status ?? null,
    input.detail ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  ]);
  // Denormalized for lists: the run row itself carries the step it is on, so a page of many
  // runs never folds every timeline.
  if (input.type === "step" && input.label) await q.run("UPDATE runs SET current_step = ? WHERE id = ? AND org_id = ?", [input.label, runId, oid()]);
  const ev = (await q.get<RunEvent>("SELECT * FROM run_events WHERE id = ?", [row!.id]))!;
  notify("run-event", ev);
  return ev;
}

export async function runEvents(runId: number): Promise<RunEvent[]> {
  return q.all<RunEvent>("SELECT * FROM run_events WHERE run_id = ? AND org_id = ? ORDER BY id", [runId, oid()]);
}

export type ActivityRow = RunEvent & { run_label: string | null; run_kind: RunKind; provider: string | null; agent_id: number | null; agent_name: string | null; task_id: number | null; run_status: RunStatus };

/** The newest timeline lines across every run: the unified activity feed. */
export async function recentRunEvents(opts: { limit?: number; since?: string; provider?: string; agent_id?: number; run_id?: number } = {}): Promise<ActivityRow[]> {
  const where: string[] = ["e.org_id = ?"];
  const params: unknown[] = [oid()];
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
  return q.all<ActivityRow>(
    `SELECT e.*, r.label AS run_label, r.kind AS run_kind, r.provider, r.agent_id, a.name AS agent_name, r.task_id, r.status AS run_status
     FROM run_events e JOIN runs r ON r.id = e.run_id LEFT JOIN agent_profiles a ON a.id = r.agent_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.id DESC LIMIT ?`,
    [...params, limit],
  );
}

/** The step a running run is on right now, for lists that show many runs at once. */
export async function currentStepOf(runId: number): Promise<{ label: string; status: StepStatus; at: string } | null> {
  const steps = foldSteps(await runEvents(runId));
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
export async function addEvent(input: EventInput): Promise<EventRow | null> {
  // Dedupe in the insert itself: under concurrency a SELECT-then-INSERT lets both writers
  // through, and the loser used to surface a unique violation. On conflict no row returns.
  const row = await q.get<{ id: number }>(
    `INSERT INTO events (org_id, platform, kind, title, body, link, read, occurred_at, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [
    oid(),
    input.platform ?? null,
    input.kind,
    input.title,
    input.body ?? null,
    input.link ?? null,
    input.occurred_at ?? now(),
    now(),
    input.dedupe_key ?? null,
  ]);
  if (!row) return null;
  const ev = (await q.get<EventRow>("SELECT * FROM events WHERE id = ?", [row.id]))!;
  notify("notification", ev);
  return ev;
}

export async function listEvents(opts: { limit?: number; unread?: boolean; platform?: string } = {}): Promise<EventRow[]> {
  const where: string[] = ["org_id = ?"];
  const params: unknown[] = [oid()];
  if (opts.unread) where.push("read = 0");
  if (opts.platform) {
    where.push("platform = ?");
    params.push(opts.platform);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return q.all<EventRow>(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY occurred_at DESC LIMIT ?`, [...params, limit]);
}

export async function markEventRead(id: number, read = true): Promise<boolean> {
  return (await q.run("UPDATE events SET read = ? WHERE id = ? AND org_id = ?", [read ? 1 : 0, id, oid()])).changes > 0;
}
export async function markAllEventsRead(): Promise<number> {
  return (await q.run("UPDATE events SET read = 1 WHERE read = 0 AND org_id = ?", [oid()])).changes;
}

/* ---------- platform state ---------- */

export async function getPlatformState(platform: string): Promise<PlatformState> {
  const row = await q.get<PlatformState>("SELECT * FROM platform_state WHERE platform = ? AND org_id = ?", [platform, oid()]);
  return row ?? { platform, session_status: "unknown", last_sync_at: null, last_ok_at: null, last_error: null, screenshot_path: null, meta: null };
}

export async function setPlatformState(platform: string, patch: Partial<Omit<PlatformState, "platform">>): Promise<PlatformState> {
  const cur = await getPlatformState(platform);
  const next: PlatformState = { ...cur, ...patch, platform };
  await q.run(
    `INSERT INTO platform_state (org_id, platform, session_status, last_sync_at, last_ok_at, last_error, screenshot_path, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, platform) DO UPDATE SET session_status=excluded.session_status, last_sync_at=excluded.last_sync_at,
       last_ok_at=excluded.last_ok_at, last_error=excluded.last_error, screenshot_path=excluded.screenshot_path, meta=excluded.meta`,
    [oid(), platform, next.session_status, next.last_sync_at, next.last_ok_at, next.last_error, next.screenshot_path, next.meta],
  );
  notify("platform:row", platform);
  return next;
}

export async function allPlatformStates(): Promise<PlatformState[]> {
  return q.all<PlatformState>("SELECT * FROM platform_state WHERE org_id = ?", [oid()]);
}

/* ---------- captures ---------- */

export async function addCapture(c: { platform: string; url: string; method: string; status: number; content_type: string; body: string }): Promise<void> {
  const MAX = 512 * 1024;
  const body = c.body.length > MAX ? c.body.slice(0, MAX) : c.body;
  await q.run(`INSERT INTO captures (org_id, platform, url, method, status, content_type, body, size, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [oid(), c.platform, c.url, c.method, c.status, c.content_type, body, c.body.length, now()]);
}

export async function pruneCaptures(platform: string, keep = 300): Promise<void> {
  await q.run(`DELETE FROM captures WHERE platform = ? AND org_id = ? AND id NOT IN (SELECT id FROM captures WHERE platform = ? AND org_id = ? ORDER BY id DESC LIMIT ?)`, [platform, oid(), platform, oid(), keep]);
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

export async function listCaptures(platform: string, limit = 100): Promise<CaptureSummary[]> {
  return q.all<CaptureSummary>(`SELECT id, url, method, status, content_type, size, captured_at FROM captures WHERE platform = ? AND org_id = ? ORDER BY id DESC LIMIT ?`, [platform, oid(), limit]);
}

export async function getCapture(id: number): Promise<(CaptureSummary & { platform: string; body: string }) | undefined> {
  return q.get<CaptureSummary & { platform: string; body: string }>("SELECT * FROM captures WHERE id = ? AND org_id = ?", [id, oid()]);
}

/* ---------- sync log ---------- */

export async function startSyncLog(platform: string): Promise<number> {
  const row = await q.get<{ id: number }>("INSERT INTO sync_log (org_id, platform, started_at) VALUES (?, ?, ?) RETURNING id", [oid(), platform, now()]);
  return row!.id;
}
export async function finishSyncLog(id: number, r: { ok: boolean; message?: string; agents?: number; runs?: number; captures?: number }): Promise<void> {
  await q.run(`UPDATE sync_log SET finished_at=?, ok=?, message=?, agents_found=?, runs_found=?, captures=? WHERE id=? AND org_id=?`, [now(), r.ok ? 1 : 0, r.message ?? null, r.agents ?? 0, r.runs ?? 0, r.captures ?? 0, id, oid()]);
}
export async function recentSyncLogs(limit = 30): Promise<unknown[]> {
  return q.all("SELECT * FROM sync_log WHERE org_id = ? ORDER BY id DESC LIMIT ?", [oid(), limit]);
}

/* ---------- settings ---------- */

export async function getSetting(key: string): Promise<string | undefined> {
  const r = await q.get<{ value: string }>("SELECT value FROM settings WHERE key = ? AND org_id = ?", [key, oid()]);
  return r?.value;
}
export async function setSetting(key: string, value: string): Promise<void> {
  await q.run("INSERT INTO settings (key, org_id, value) VALUES (?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value", [key, oid(), value]);
  settingCache.delete(`${oid()}:${key}`);
}

/** sha256 hex — how bearer credentials in this layer are stored and looked up. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Which workspace an agent's ingest token belongs to. Global by nature: the token IS the
 * lookup key. Stored as sha256 hex (migration 14/108), so the presented plaintext is hashed
 * before the indexed lookup — the database never holds or scans the secret itself.
 */
export async function findOrgIdByIngestToken(token: string): Promise<number | undefined> {
  const r = await q.get<{ org_id: number }>("SELECT org_id FROM settings WHERE key = 'ingest_token' AND value = ?", [sha256(token)]);
  return r?.org_id;
}

/** Store this workspace's ingest token — hashed; the plaintext is the caller's to show once. */
export async function setIngestToken(plaintext: string): Promise<void> {
  await setSetting("ingest_token", sha256(plaintext));
}

/** Whether this workspace has an ingest token at all. The secret itself is never readable back. */
export async function hasIngestToken(): Promise<boolean> {
  return (await getSetting("ingest_token")) !== undefined;
}

/**
 * A setting read on hot paths (per request, per capability check). The TTL bounds staleness
 * across instances; a write through setSetting on this instance invalidates at once.
 */
const settingCache = new Map<string, { v: string | undefined; at: number }>();
export async function getSettingCached(key: string, ttlMs = 5_000): Promise<string | undefined> {
  const cacheKey = `${oid()}:${key}`;
  const hit = settingCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await getSetting(key);
  settingCache.set(cacheKey, { v, at: Date.now() });
  return v;
}

/* ---------- browser ops (interactive browser work crossing processes) ---------- */

export interface BrowserOpRow {
  id: number;
  org_id: number;
  op: string;
  payload: string | null;
  status: "pending" | "done" | "failed";
  result: string | null;
  created_at: string;
  finished_at: string | null;
}

export async function createBrowserOp(op: string, payload: unknown): Promise<BrowserOpRow> {
  const row = await q.get<{ id: number }>("INSERT INTO browser_ops (org_id, op, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?) RETURNING id", [oid(), op, payload === undefined ? null : JSON.stringify(payload), now()]);
  return (await getBrowserOp(row!.id))!;
}
export async function getBrowserOp(id: number): Promise<BrowserOpRow | undefined> {
  return q.get<BrowserOpRow>("SELECT * FROM browser_ops WHERE id = ? AND org_id = ?", [id, oid()]);
}
/** A browser-op row wherever it lives — the org-adoption peek for the browser.op job. */
export async function getBrowserOpAnyOrg(id: number): Promise<BrowserOpRow | undefined> {
  assertSystem();
  return q.get<BrowserOpRow>("SELECT * FROM browser_ops WHERE id = ?", [id]);
}
export async function finishBrowserOp(id: number, status: "done" | "failed", result: unknown): Promise<void> {
  await q.run("UPDATE browser_ops SET status = ?, result = ?, finished_at = ? WHERE id = ? AND org_id = ? AND status = 'pending'", [status, result === undefined ? null : JSON.stringify(result), now(), id, oid()]);
}
export async function pruneBrowserOps(olderThanMs = 60 * 60_000): Promise<number> {
  return (await q.run("DELETE FROM browser_ops WHERE created_at < ?", [new Date(Date.now() - olderThanMs).toISOString()])).changes;
}

/* ---------- browser session state (sealed storageState blobs) ---------- */

export async function getBrowserSession(id: string): Promise<string | undefined> {
  const r = await q.get<{ blob: string }>("SELECT blob FROM browser_sessions WHERE id = ? AND org_id = ?", [id, oid()]);
  return r?.blob;
}
export async function setBrowserSession(id: string, blob: string): Promise<void> {
  await q.run("INSERT INTO browser_sessions (id, org_id, blob, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at", [id, oid(), blob, now()]);
}
/** Which workspaces have browser sessions at all — the sync dispatcher's fan-out list. */
export async function listBrowserSessionOrgsAll(): Promise<number[]> {
  assertSystem();
  return (await q.all<{ org_id: number }>("SELECT DISTINCT org_id FROM browser_sessions")).map((r) => r.org_id);
}
export async function browserSessionUpdatedAt(id: string): Promise<string | undefined> {
  const r = await q.get<{ updated_at: string }>("SELECT updated_at FROM browser_sessions WHERE id = ? AND org_id = ?", [id, oid()]);
  return r?.updated_at;
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

export async function listAgentProfiles(opts: { provider?: string; kind?: string; includeDisabled?: boolean } = {}): Promise<AgentProfileSummary[]> {
  const where: string[] = ["a.org_id = ?"];
  const params: unknown[] = [oid()];
  if (opts.provider) {
    where.push("a.provider_id = ?");
    params.push(opts.provider);
  }
  if (opts.kind) {
    where.push("a.kind = ?");
    params.push(opts.kind);
  }
  if (!opts.includeDisabled) where.push("a.status != 'disabled'");
  return q.all<AgentProfileSummary>(`${AGENT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.kind, a.name`, params);
}

export async function getAgentProfile(id: number): Promise<AgentProfileSummary | undefined> {
  return q.get<AgentProfileSummary>(`${AGENT_SELECT} WHERE a.id = ? AND a.org_id = ?`, [id, oid()]);
}

export async function findAgentProfile(key: string): Promise<AgentProfileSummary | undefined> {
  return q.get<AgentProfileSummary>(`${AGENT_SELECT} WHERE a.key = ? AND a.org_id = ?`, [key, oid()]);
}

/** Insert or update by key. Fields that are undefined are left untouched on update. */
export async function upsertAgentProfile(input: AgentProfileInput): Promise<AgentProfileSummary> {
  const existing = await findAgentProfile(input.key);
  const ts = now();
  const caps = input.capabilities === undefined ? undefined : input.capabilities === null ? null : JSON.stringify(input.capabilities);
  const conf = input.configuration === undefined ? undefined : input.configuration === null ? null : JSON.stringify(input.configuration);
  if (existing) {
    await q.run(
      `UPDATE agent_profiles SET name = COALESCE(?, name), description = COALESCE(?, description), provider_id = COALESCE(?, provider_id), kind = COALESCE(?, kind),
         capabilities = COALESCE(?, capabilities), status = COALESCE(?, status), configuration = COALESCE(?, configuration), updated_at = ? WHERE id = ? AND org_id = ?`,
      [input.name ?? null, input.description ?? null, input.provider_id ?? null, input.kind ?? null, caps ?? null, input.status ?? null, conf ?? null, ts, existing.id, oid()],
    );
    const a = (await getAgentProfile(existing.id))!;
    notify("agent", a);
    return a;
  }
  const row = await q.get<{ id: number }>(`INSERT INTO agent_profiles (org_id, key, name, description, provider_id, kind, capabilities, status, configuration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
    oid(),
    input.key,
    input.name ?? input.key,
    input.description ?? null,
    input.provider_id ?? null,
    input.kind ?? "custom",
    caps ?? null,
    input.status ?? "active",
    conf ?? null,
    ts,
    ts,
  ]);
  const a = (await getAgentProfile(row!.id))!;
  notify("agent", a);
  return a;
}

export async function updateAgentProfile(id: number, patch: Partial<AgentProfileInput>): Promise<AgentProfileSummary | undefined> {
  const a = await getAgentProfile(id);
  if (!a) return undefined;
  await q.run(`UPDATE agent_profiles SET name=?, description=?, provider_id=?, kind=?, capabilities=?, status=?, configuration=?, updated_at=? WHERE id=? AND org_id=?`, [
    patch.name ?? a.name,
    patch.description === undefined ? a.description : patch.description,
    patch.provider_id === undefined ? a.provider_id : patch.provider_id,
    patch.kind ?? a.kind,
    patch.capabilities === undefined ? a.capabilities : patch.capabilities === null ? null : JSON.stringify(patch.capabilities),
    patch.status ?? a.status,
    patch.configuration === undefined ? a.configuration : patch.configuration === null ? null : JSON.stringify(patch.configuration),
    now(),
    id,
    oid(),
  ]);
  const next = await getAgentProfile(id);
  if (next) notify("agent", next);
  return next;
}

export async function deleteAgentProfile(id: number): Promise<boolean> {
  const ok = (await q.run("DELETE FROM agent_profiles WHERE id = ? AND org_id = ?", [id, oid()])).changes > 0;
  if (ok) notify("agent:deleted", { id });
  return ok;
}

/* ---------- policies, approvals, audit ---------- */

export async function getPolicyOverrides(): Promise<Record<string, PolicyMode>> {
  const out: Record<string, PolicyMode> = {};
  for (const r of await q.all<{ action: string; mode: PolicyMode }>("SELECT action, mode FROM policies WHERE org_id = ?", [oid()])) out[r.action] = r.mode;
  return out;
}
export async function setPolicyOverride(action: string, mode: PolicyMode | null): Promise<void> {
  if (mode === null) await q.run("DELETE FROM policies WHERE action = ? AND org_id = ?", [action, oid()]);
  else await q.run("INSERT INTO policies (action, org_id, mode, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, action) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at", [action, oid(), mode, now()]);
}

export type ApprovalRow = Approval & { run_label: string | null; run_kind: string | null };
const APPROVAL_SELECT = `SELECT a.*, r.label AS run_label, r.kind AS run_kind FROM approvals a LEFT JOIN runs r ON r.id = a.run_id`;

export async function createApproval(input: { run_id?: number | null; message_id?: number | null; action: string; provider?: string | null; summary: string; detail?: string | null }): Promise<ApprovalRow> {
  const row = await q.get<{ id: number }>(`INSERT INTO approvals (org_id, run_id, message_id, action, provider, summary, detail, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id`, [
    oid(),
    input.run_id ?? null,
    input.message_id ?? null,
    input.action,
    input.provider ?? null,
    input.summary,
    input.detail ?? null,
    now(),
  ]);
  const a = (await getApproval(row!.id))!;
  notify("approval", a);
  return a;
}
export async function getApproval(id: number): Promise<ApprovalRow | undefined> {
  return q.get<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.id = ? AND a.org_id = ?`, [id, oid()]);
}
export async function updateApproval(id: number, patch: { status: ApprovalStatus; decided_by?: string | null; reason?: string | null }): Promise<ApprovalRow | undefined> {
  const a = await getApproval(id);
  if (!a) return undefined;
  // Guarded: only a pending approval can be decided/expired/interrupted. Whoever loses the
  // race (a decision landing at the same moment as the timeout sweep) gets undefined and
  // backs off — an approval never carries one outcome while its run settles with another.
  const res = await q.run("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ? AND org_id = ? AND status = 'pending'", [
    patch.status,
    patch.status === "pending" ? null : now(),
    patch.decided_by ?? a.decided_by,
    patch.reason ?? a.reason,
    id,
    oid(),
  ]);
  if (res.changes === 0) return undefined;
  const next = (await getApproval(id))!;
  notify("approval", next);
  return next;
}
/** Pending approvals across every workspace — the timeout sweep's and boot recovery's worklist. */
export async function listPendingApprovalsAll(limit = 500): Promise<(ApprovalRow & { org_id: number })[]> {
  assertSystem();
  return q.all<ApprovalRow & { org_id: number }>(`${APPROVAL_SELECT} WHERE a.status = 'pending' ORDER BY a.requested_at DESC LIMIT ?`, [limit]);
}

export async function listApprovals(opts: { status?: ApprovalStatus | ApprovalStatus[]; message_id?: number; run_id?: number; limit?: number } = {}): Promise<ApprovalRow[]> {
  const where: string[] = ["a.org_id = ?"];
  const params: unknown[] = [oid()];
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
  return q.all<ApprovalRow>(`${APPROVAL_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.requested_at DESC LIMIT ?`, [...params, limit]);
}

export async function addAudit(input: { actor: string; action: string; target?: string | null; detail?: string | null; metadata?: unknown }): Promise<AuditEntry> {
  // The one deliberate scope exception: security events (failed logins, sign-up attempts)
  // legitimately happen before any workspace is known and land in the founding workspace's
  // audit, whose owner operates the install.
  const org = currentOrgId() ?? 1;
  const row = await q.get<{ id: number }>("INSERT INTO audit_log (org_id, at, actor, action, target, detail, metadata) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id", [
    org,
    now(),
    input.actor,
    input.action,
    input.target ?? null,
    input.detail ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  ]);
  return (await q.get<AuditEntry>("SELECT * FROM audit_log WHERE id = ?", [row!.id]))!;
}
export async function listAudit(opts: { limit?: number; action?: string } = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  if (opts.action) return q.all<AuditEntry>("SELECT * FROM audit_log WHERE org_id = ? AND action LIKE ? ORDER BY id DESC LIMIT ?", [oid(), opts.action + "%", limit]);
  return q.all<AuditEntry>("SELECT * FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT ?", [oid(), limit]);
}

/* ---------- users ---------- */

export type UserRole = "owner" | "admin" | "member";
export interface UserRow {
  id: number;
  org_id: number;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  /** Null until the verification link is clicked; accounts from before verification are grandfathered. */
  verified_at: string | null;
}

export async function createUser(input: { email: string; password_hash: string; role?: UserRole; verified?: boolean }): Promise<UserRow> {
  const ts = now();
  const row = await q.get<{ id: number }>("INSERT INTO users (org_id, email, password_hash, role, created_at, updated_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id", [
    oid(),
    input.email.trim().toLowerCase(),
    input.password_hash,
    input.role ?? "member",
    ts,
    ts,
    input.verified === false ? null : ts,
  ]);
  return (await getUser(row!.id))!;
}
/** By-id and by-email lookups are global: they ARE how a request finds its workspace. */
export async function getUser(id: number): Promise<UserRow | undefined> {
  return q.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
}
export async function getUserByEmail(email: string): Promise<UserRow | undefined> {
  return q.get<UserRow>("SELECT * FROM users WHERE email = ?", [email.trim().toLowerCase()]);
}
export async function listUsers(): Promise<Omit<UserRow, "password_hash">[]> {
  return q.all<Omit<UserRow, "password_hash">>("SELECT id, org_id, email, role, created_at, updated_at, last_login_at, verified_at FROM users WHERE org_id = ? ORDER BY id", [oid()]);
}
/** Every account on the install: login-time resolution (which account does this credential belong to). */
export async function listAllUsers(): Promise<Pick<UserRow, "id" | "email">[]> {
  return q.all<Pick<UserRow, "id" | "email">>("SELECT id, email FROM users ORDER BY id");
}
/** Install-wide count: drives first-run setup, which happens before any workspace exists. */
export async function countUsers(): Promise<number> {
  return (await q.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n;
}
export async function updateUser(id: number, patch: { password_hash?: string; role?: UserRole; last_login_at?: string }): Promise<UserRow | undefined> {
  // Global by id: login upgrades a hash before any scope exists; ids come from verified lookups.
  const u = await getUser(id);
  if (!u) return undefined;
  await q.run("UPDATE users SET password_hash = ?, role = ?, last_login_at = ?, updated_at = ? WHERE id = ?", [
    patch.password_hash ?? u.password_hash,
    patch.role ?? u.role,
    patch.last_login_at ?? u.last_login_at,
    now(),
    id,
  ]);
  return getUser(id);
}
export async function deleteUser(id: number): Promise<boolean> {
  return (await q.run("DELETE FROM users WHERE id = ? AND org_id = ?", [id, oid()])).changes > 0;
}
export async function setUserVerified(id: number): Promise<void> {
  await q.run("UPDATE users SET verified_at = ?, updated_at = ? WHERE id = ? AND verified_at IS NULL", [now(), now(), id]);
}

/* ---------- one-time account tokens (email verification, password reset) ---------- */

export interface UserTokenRow {
  id: number;
  user_id: number;
  kind: "verify" | "reset";
  token_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export async function createUserToken(userId: number, kind: "verify" | "reset", tokenHash: string, ttlMs: number): Promise<void> {
  await q.run("INSERT INTO user_tokens (user_id, kind, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", [userId, kind, tokenHash, now(), new Date(Date.now() + ttlMs).toISOString()]);
}
/** Redeem a token exactly once: the guarded update wins or the call returns undefined. */
export async function consumeUserToken(tokenHash: string, kind: "verify" | "reset"): Promise<UserTokenRow | undefined> {
  const row = await q.get<UserTokenRow>("SELECT * FROM user_tokens WHERE token_hash = ? AND kind = ?", [tokenHash, kind]);
  if (!row || row.used_at || row.expires_at <= now()) return undefined;
  const res = await q.run("UPDATE user_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL", [now(), row.id]);
  return res.changes > 0 ? row : undefined;
}
export async function pruneUserTokens(): Promise<number> {
  return (await q.run("DELETE FROM user_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", [new Date(Date.now() - 24 * 60 * 60_000).toISOString()])).changes;
}
export async function deleteSessionsForUser(userId: number): Promise<number> {
  return (await q.run("DELETE FROM sessions WHERE user_id = ?", [userId])).changes;
}

/* ---------- login sessions ---------- */

export interface SessionRow {
  id: number;
  org_id: number;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  user_id: number | null;
}

export async function insertSession(input: { token_hash: string; expires_at: string; user_agent?: string | null; ip?: string | null; user_id?: number | null; org_id?: number }): Promise<SessionRow> {
  const ts = now();
  const row = await q.get<{ id: number }>("INSERT INTO sessions (org_id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", [
    input.org_id ?? 1,
    input.token_hash,
    ts,
    ts,
    input.expires_at,
    input.user_agent ?? null,
    input.ip ?? null,
    input.user_id ?? null,
  ]);
  return (await q.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", [row!.id]))!;
}
export async function findSession(tokenHash: string): Promise<SessionRow | undefined> {
  return q.get<SessionRow>("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?", [tokenHash, now()]);
}
export async function touchSession(id: number): Promise<void> {
  await q.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [now(), id]);
}
export async function deleteSession(tokenHash: string): Promise<boolean> {
  return (await q.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash])).changes > 0;
}
export async function deleteAllSessions(): Promise<number> {
  return (await q.run("DELETE FROM sessions")).changes;
}
export async function purgeExpiredSessions(): Promise<number> {
  return (await q.run("DELETE FROM sessions WHERE expires_at <= ?", [now()])).changes;
}
export async function countSessions(): Promise<number> {
  return (await q.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", [now()]))!.n;
}

/* ---------- pairings (a sign-in done on the user's own computer, handed to the cloud browser) ---------- */

export type PairingStatus = "waiting" | "paired" | "importing" | "done" | "failed" | "expired" | "cancelled" | "replaced";
export interface PairingRow {
  id: number;
  org_id: number;
  platform: string;
  code_hash: string;
  token_hash: string | null;
  status: PairingStatus;
  detail: string | null;
  created_at: string;
  /** While waiting: when the code dies. Once paired: when the token dies. */
  expires_at: string;
  paired_at: string | null;
  finished_at: string | null;
  ip: string | null;
}

export async function insertPairing(input: { platform: string; code_hash: string; expires_at: string }): Promise<PairingRow> {
  const row = await q.get<{ id: number }>("INSERT INTO pairings (org_id, platform, code_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'waiting', ?, ?) RETURNING id", [oid(), input.platform, input.code_hash, now(), input.expires_at]);
  return (await q.get<PairingRow>("SELECT * FROM pairings WHERE id = ?", [row!.id]))!;
}
// Pairing lookups by id/code/token are global on purpose: the exchange arrives with no login
// and no workspace — the hashed code or token IS the capability, and the caller adopts the
// row's org before importing anything.
export async function getPairing(id: number): Promise<PairingRow | undefined> {
  return q.get<PairingRow>("SELECT * FROM pairings WHERE id = ?", [id]);
}
export async function findPairingByCodeHash(hash: string): Promise<PairingRow | undefined> {
  return q.get<PairingRow>("SELECT * FROM pairings WHERE code_hash = ? AND status = 'waiting' AND expires_at > ?", [hash, now()]);
}
export async function findPairingByTokenHash(hash: string): Promise<PairingRow | undefined> {
  return q.get<PairingRow>("SELECT * FROM pairings WHERE token_hash = ? AND status IN ('paired', 'importing') AND expires_at > ?", [hash, now()]);
}
export async function updatePairing(id: number, patch: Partial<Pick<PairingRow, "status" | "detail" | "token_hash" | "expires_at" | "paired_at" | "finished_at" | "ip">>): Promise<PairingRow | undefined> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  if (cols.length) await q.run(`UPDATE pairings SET ${cols.join(", ")} WHERE id = ?`, [...vals, id]);
  return getPairing(id);
}

/* ---------- desktop devices: the connectors that run a workspace's browser on its owner's computer ---------- */

export interface DeviceRow {
  id: number;
  org_id: number;
  user_id: number | null;
  name: string;
  /** sha256 of the device token; the token itself is shown once and never stored. */
  token_hash: string;
  os: string | null;
  app_version: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export async function insertDevice(input: { name: string; user_id: number | null; token_hash: string }): Promise<DeviceRow> {
  const row = await q.get<{ id: number }>("INSERT INTO devices (org_id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id", [oid(), input.user_id, input.name, input.token_hash, now()]);
  return (await getDevice(row!.id))!;
}
export async function listDevices(): Promise<DeviceRow[]> {
  return q.all<DeviceRow>("SELECT * FROM devices WHERE org_id = ? ORDER BY id", [oid()]);
}
export async function getDevice(id: number): Promise<DeviceRow | undefined> {
  return q.get<DeviceRow>("SELECT * FROM devices WHERE id = ? AND org_id = ?", [id, oid()]);
}
// The token lookup is global on purpose: a connector arrives with no login and no workspace —
// the hashed token IS the capability, and the gateway adopts the row's org.
export async function findDeviceByTokenHash(hash: string): Promise<DeviceRow | undefined> {
  return q.get<DeviceRow>("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL", [hash]);
}
export async function updateDevice(id: number, patch: Partial<Pick<DeviceRow, "name" | "os" | "app_version" | "last_seen_at" | "revoked_at">>): Promise<DeviceRow | undefined> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  if (cols.length) await q.run(`UPDATE devices SET ${cols.join(", ")} WHERE id = ? AND org_id = ?`, [...vals, id, oid()]);
  return getDevice(id);
}
export async function latestPairing(platform: string): Promise<PairingRow | undefined> {
  return q.get<PairingRow>("SELECT * FROM pairings WHERE platform = ? AND org_id = ? ORDER BY id DESC LIMIT 1", [platform, oid()]);
}
/** Codes and tokens die on their own; nothing lingers as "waiting" past its time. */
export async function expirePairings(): Promise<number> {
  return (await q.run("UPDATE pairings SET status = 'expired', token_hash = NULL, finished_at = ? WHERE status IN ('waiting', 'paired', 'importing') AND expires_at <= ?", [now(), now()])).changes;
}
/** A new code for a provider retires any earlier one still waiting. */
export async function replaceWaitingPairings(platform: string, exceptId: number): Promise<number> {
  return (await q.run("UPDATE pairings SET status = 'replaced', finished_at = ? WHERE platform = ? AND org_id = ? AND status = 'waiting' AND id <> ?", [now(), platform, oid(), exceptId])).changes;
}

/* ---------- overview ---------- */

export async function overviewCounts() {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const tasks = (await q.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE enabled = 1 AND org_id = ?", [oid()]))!;
  const failed = (await q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('failed','needs_attention') AND COALESCE(finished_at, started_at, created_at) > ? AND org_id = ?`, [daysAgo(7), oid()]))!;
  const unread = (await q.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE read = 0 AND org_id = ?", [oid()]))!;
  const runs24h = (await q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE COALESCE(finished_at, started_at, created_at) > ? AND org_id = ?`, [daysAgo(1), oid()]))!;
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
  /** 1 while any message in the thread is still being worked on, else 0. */
  active: number;
};

const CONVERSATION_SELECT = `SELECT c.*,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
  (SELECT status FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_status,
  (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
  (SELECT platform FROM messages m WHERE m.conversation_id = c.id AND m.platform IS NOT NULL ORDER BY m.created_at DESC LIMIT 1) AS last_platform,
  CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.status IN ('assigned','delivered')) THEN 1 ELSE 0 END AS active
  FROM conversations c`;

export async function createConversation(title = ""): Promise<ConversationSummary> {
  const ts = now();
  const row = await q.get<{ id: number }>("INSERT INTO conversations (org_id, title, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, NULL) RETURNING id", [oid(), title.slice(0, 120), ts, ts]);
  const c = (await getConversation(row!.id))!;
  notify("conversation", { action: "created", conversation: c });
  return c;
}

export async function getConversation(id: number): Promise<ConversationSummary | undefined> {
  return q.get<ConversationSummary>(`${CONVERSATION_SELECT} WHERE c.id = ? AND c.org_id = ?`, [id, oid()]);
}

export async function listConversations(limit = 200): Promise<ConversationSummary[]> {
  return q.all<ConversationSummary>(`${CONVERSATION_SELECT} WHERE c.org_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`, [oid(), Math.min(Math.max(limit, 1), 1000)]);
}

export async function updateConversation(id: number, patch: { title?: string; last_message_at?: string }): Promise<ConversationSummary | undefined> {
  const c = await getConversation(id);
  if (!c) return undefined;
  await q.run("UPDATE conversations SET title = ?, last_message_at = ?, updated_at = ? WHERE id = ? AND org_id = ?", [
    patch.title === undefined ? c.title : patch.title.slice(0, 120),
    patch.last_message_at === undefined ? c.last_message_at : patch.last_message_at,
    now(),
    id,
    oid(),
  ]);
  const next = (await getConversation(id))!;
  notify("conversation", { action: "updated", conversation: next });
  return next;
}

export async function deleteConversation(id: number): Promise<boolean> {
  const c = await getConversation(id);
  if (!c) return false;
  await q.run("DELETE FROM messages WHERE conversation_id = ? AND org_id = ?", [id, oid()]);
  await q.run("DELETE FROM conversations WHERE id = ? AND org_id = ?", [id, oid()]);
  notify("conversation", { action: "deleted", conversation: c });
  return true;
}

/** Messages of one thread, oldest first. */
export async function conversationMessages(conversationId: number, limit = 300): Promise<MessageWithTask[]> {
  return q.all<MessageWithTask>(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.org_id = ? ORDER BY m.created_at ASC, m.id ASC LIMIT ?`, [conversationId, oid(), Math.min(Math.max(limit, 1), 2000)]);
}

/* ---------- messages (what you typed; each one may point at a run) ---------- */

export type MessageWithTask = MessageRow & { task_name: string | null; task_platform: string | null; task_key: string | null; task_native_url: string | null };
/** @deprecated use MessageWithTask. */
export type MessageWithAgent = MessageWithTask;

const MESSAGE_SELECT = `SELECT m.*, t.name AS task_name, t.platform AS task_platform, t.key AS task_key, t.native_url AS task_native_url
  FROM messages m LEFT JOIN tasks t ON t.id = m.task_id`;

export async function createMessage(text: string, conversationId: number | null = null): Promise<MessageRow> {
  const ts = now();
  const row = await q.get<{ id: number }>(`INSERT INTO messages (org_id, text, status, conversation_id, created_at, updated_at) VALUES (?, ?, 'needs_assignment', ?, ?, ?) RETURNING id`, [oid(), text, conversationId, ts, ts]);
  if (conversationId) {
    await q.run("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ? AND org_id = ?", [ts, ts, conversationId, oid()]);
    const c = await getConversation(conversationId);
    if (c) notify("conversation", { action: "updated", conversation: c });
  }
  const m = (await getMessage(row!.id))!;
  notify("message:row", m);
  return m;
}

export async function getMessage(id: number): Promise<MessageWithTask | undefined> {
  return q.get<MessageWithTask>(`${MESSAGE_SELECT} WHERE m.id = ? AND m.org_id = ?`, [id, oid()]);
}

/** A message row wherever it lives — the org-adoption peek for delivery jobs. */
export async function getMessageAnyOrg(id: number): Promise<(MessageWithTask & { org_id: number }) | undefined> {
  assertSystem();
  return q.get<MessageWithTask & { org_id: number }>(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
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

export async function updateMessage(id: number, patch: MessagePatch): Promise<MessageWithTask | undefined> {
  const m = await getMessage(id);
  if (!m) return undefined;
  const json = (v: unknown, cur: string | null) => (v === undefined ? cur : v === null ? null : JSON.stringify(v));
  await q.run(`UPDATE messages SET status=?, platform=?, task_id=?, run_id=?, suggestions=?, routing=?, delivery_mode=?, delivered_at=?, acked_at=?, response=?, error=?, steps=?, updated_at=? WHERE id=? AND org_id=?`, [
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
    oid(),
  ]);
  const next = await getMessage(id);
  if (next) {
    notify("message:row", next);
    // A status change is what the thread list cares about (running dot, last status).
    if (next.conversation_id && patch.status && patch.status !== m.status) {
      const c = await getConversation(next.conversation_id);
      if (c) notify("conversation", { action: "updated", conversation: c });
    }
  }
  return next;
}

export async function listMessages(opts: { status?: string; task_id?: number; limit?: number } = {}): Promise<MessageWithTask[]> {
  const where: string[] = ["m.org_id = ?"];
  const params: unknown[] = [oid()];
  if (opts.status) {
    where.push("m.status = ?");
    params.push(opts.status);
  }
  if (opts.task_id) {
    where.push("m.task_id = ?");
    params.push(opts.task_id);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return q.all<MessageWithTask>(`${MESSAGE_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.created_at DESC LIMIT ?`, [...params, limit]);
}

/** Messages waiting for a task's agent that pulls its instructions. */
export async function inboxFor(taskId: number): Promise<MessageWithTask[]> {
  return q.all<MessageWithTask>(`${MESSAGE_SELECT} WHERE m.task_id = ? AND m.org_id = ? AND m.delivery_mode = 'inbox' AND m.status IN ('assigned','delivered') ORDER BY m.created_at ASC`, [taskId, oid()]);
}

export async function deleteMessage(id: number): Promise<boolean> {
  const m = await getMessage(id);
  const ok = (await q.run("DELETE FROM messages WHERE id = ? AND org_id = ?", [id, oid()])).changes > 0;
  if (ok && m) {
    notify("message:deleted", { id, conversation_id: m.conversation_id });
    if (m.conversation_id) {
      const c = await getConversation(m.conversation_id);
      if (c) notify("conversation", { action: "updated", conversation: c });
    }
  }
  return ok;
}

export async function openMessageCount(): Promise<number> {
  return (await q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE status IN ('needs_assignment','failed') AND org_id = ?`, [oid()]))!.n;
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
export async function runStats(days = 14): Promise<DayStat[]> {
  const n = Math.min(Math.max(days, 1), 90);
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (n - 1));
  const rows = await q.all<{ day: string; status: string; n: number }>(
    `SELECT substr(COALESCE(finished_at, started_at, created_at), 1, 10) AS day, status, COUNT(*) AS n FROM runs WHERE COALESCE(finished_at, started_at, created_at) >= ? AND org_id = ? GROUP BY day, status`,
    [cutoff.toISOString(), oid()],
  );
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

/* ---------- operational helpers (leases, quotas, provider claims, retention) ---------- */

/** Renew a running run's lease: lease_expires_at moves ttlMs into the future and locked_by names the holder (this host by default). */
export async function heartbeatRun(id: number, ttlMs: number, owner: string = hostname()): Promise<void> {
  await q.run("UPDATE runs SET lease_expires_at = ?, locked_by = ? WHERE id = ? AND org_id = ? AND status = 'running'", [new Date(Date.now() + ttlMs).toISOString(), owner, id, oid()]);
}

/** Messages stuck mid-flight: still needs_assignment/assigned past the cutoff with no run, or a run that is no longer running/queued. */
export async function stuckMessages(cutoffIso: string): Promise<MessageRow[]> {
  return q.all<MessageRow>(
    `SELECT m.* FROM messages m LEFT JOIN runs r ON r.id = m.run_id
     WHERE m.org_id = ? AND m.status IN ('needs_assignment', 'assigned') AND m.created_at < ?
       AND (m.run_id IS NULL OR r.status NOT IN ('running', 'queued'))`,
    [oid(), cutoffIso],
  );
}

/** How many of this workspace's runs are still in a non-terminal status — the concurrency-quota gate. */
export async function activeRunCount(): Promise<number> {
  return (await q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE org_id = ? AND status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(",")})`, [oid(), ...ACTIVE_RUN_STATUSES]))!.n;
}

/** How many runs this workspace has created since the timestamp — the daily-quota gate. */
export async function runCountSince(iso: string): Promise<number> {
  return (await q.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE org_id = ? AND created_at >= ?", [oid(), iso]))!.n;
}

/** This workspace's quota limits, from orgs.quotas JSON. Absent, null or unparseable means unlimited. */
export async function orgQuotas(): Promise<{ maxConcurrentRuns?: number; maxRunsPerDay?: number }> {
  const row = await q.get<{ quotas: string | null }>("SELECT quotas FROM orgs WHERE id = ?", [oid()]);
  if (!row?.quotas) return {};
  try {
    const parsed = JSON.parse(row.quotas) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return { maxConcurrentRuns: num(parsed.maxConcurrentRuns), maxRunsPerDay: num(parsed.maxRunsPerDay) };
  } catch {
    return {};
  }
}

/**
 * Take the per-(workspace, platform) claim that lets exactly one browser worker drive a
 * provider session. One atomic upsert: it succeeds when no claim exists, the claim expired,
 * or this owner already holds it — and then carries the new expiry. Returns whether the
 * claim is now this owner's.
 */
export async function claimProvider(platformId: string, owner: string, ttlMs: number): Promise<boolean> {
  const res = await q.run(
    `INSERT INTO provider_claims (org_id, platform_id, owner, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id, platform_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE provider_claims.owner = excluded.owner OR provider_claims.expires_at <= ?`,
    [oid(), platformId, owner, new Date(Date.now() + ttlMs).toISOString(), now()],
  );
  return res.changes > 0;
}

/** Push the claim's expiry forward — only while this owner still holds it. */
export async function renewProviderClaim(platformId: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await q.run("UPDATE provider_claims SET expires_at = ? WHERE org_id = ? AND platform_id = ? AND owner = ?", [new Date(Date.now() + ttlMs).toISOString(), oid(), platformId, owner])).changes > 0;
}

/** Give the claim up — only when it is still this owner's to give. */
export async function releaseProviderClaim(platformId: string, owner: string): Promise<void> {
  await q.run("DELETE FROM provider_claims WHERE org_id = ? AND platform_id = ? AND owner = ?", [oid(), platformId, owner]);
}

/**
 * Age out this workspace's history: timeline events of settled runs, notifications, audit
 * and sync-log rows past their window, and the raw provider payload on long-settled runs.
 * Every delete works in bounded batches (id IN a LIMITed subquery) so no pass ever holds a
 * long transaction. Returns how many rows each table lost (and how many runs lost raw).
 */
export async function pruneRetention(opts: { runEventsDays?: number; eventsDays?: number; auditDays?: number; syncLogDays?: number; stripRawDays?: number }): Promise<Record<string, number>> {
  const org = oid();
  const cutoff = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const terminal = TERMINAL_RUN_STATUSES.map(() => "?").join(",");
  const BATCH = 500;
  const batched = async (sql: string, params: unknown[]): Promise<number> => {
    let total = 0;
    for (;;) {
      const n = (await q.run(sql, params)).changes;
      total += n;
      if (n < BATCH) return total;
    }
  };
  const out: Record<string, number> = {};
  if (opts.runEventsDays !== undefined) {
    out.run_events = await batched(
      `DELETE FROM run_events WHERE id IN (SELECT e.id FROM run_events e JOIN runs r ON r.id = e.run_id WHERE e.org_id = ? AND e.at < ? AND r.status IN (${terminal}) LIMIT ${BATCH})`,
      [org, cutoff(opts.runEventsDays), ...TERMINAL_RUN_STATUSES],
    );
  }
  if (opts.eventsDays !== undefined) out.events = await batched(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE org_id = ? AND created_at < ? LIMIT ${BATCH})`, [org, cutoff(opts.eventsDays)]);
  if (opts.auditDays !== undefined) out.audit_log = await batched(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE org_id = ? AND at < ? LIMIT ${BATCH})`, [org, cutoff(opts.auditDays)]);
  if (opts.syncLogDays !== undefined) out.sync_log = await batched(`DELETE FROM sync_log WHERE id IN (SELECT id FROM sync_log WHERE org_id = ? AND started_at < ? LIMIT ${BATCH})`, [org, cutoff(opts.syncLogDays)]);
  if (opts.stripRawDays !== undefined) {
    out.runs_raw_stripped = await batched(
      `UPDATE runs SET raw = NULL WHERE id IN (SELECT id FROM runs WHERE org_id = ? AND raw IS NOT NULL AND status IN (${terminal}) AND finished_at < ? LIMIT ${BATCH})`,
      [org, ...TERMINAL_RUN_STATUSES, cutoff(opts.stripRawDays)],
    );
  }
  return out;
}

/** Last few run statuses per task, newest first, for the history dots on the tasks table. */
export async function recentStatusesByTask(limit = 6): Promise<Record<number, string[]>> {
  const rows = await q.all<{ task_id: number; status: string }>(
    `SELECT task_id, status FROM (SELECT task_id, status, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS rn FROM runs WHERE task_id IS NOT NULL AND org_id = ?) ranked WHERE rn <= ?`,
    [oid(), limit],
  );
  const out: Record<number, string[]> = {};
  for (const r of rows) (out[r.task_id] ??= []).push(r.status);
  return out;
}
