import type { PlatformConfig, RunStatus } from "../types.js";

/**
 * Structural normaliser. Web apps rename their endpoints, but a scheduled task
 * is always "an object with an id, a name and a schedule or status", and a run is
 * "an object with an id, a status and a timestamp that belongs to a task".
 * We walk every captured JSON payload and pick those shapes out, so the
 * collector keeps working without knowing exact endpoint contracts.
 */

const ID_KEYS = ["id", "uuid", "_id", "task_id", "routine_id", "bot_id", "automation_id", "schedule_id"];
/** Runs must not be keyed by their parent reference, so parent-ish keys are excluded here. */
const RUN_ID_KEYS = ["id", "uuid", "_id", "run_id", "execution_id", "job_id", "session_id", "history_id"];
const NAME_KEYS = ["title", "name", "label", "display_name", "task_name", "routine_name", "bot_name"];
const SCHEDULE_KEYS = [
  "schedule",
  "cron",
  "cron_expression",
  "rrule",
  "cadence",
  "frequency",
  "interval",
  "recurrence",
  "next_run_at",
  "next_run",
  "next_run_time",
  "next_scheduled_run",
  "scheduled_at",
  "trigger",
  "triggers",
];
const STATUS_KEYS = ["status", "state", "enabled", "is_enabled", "paused", "is_paused", "active", "is_active", "disabled", "outcome", "result_status"];
const START_KEYS = ["started_at", "start_time", "run_at", "ran_at", "created_at", "create_time", "timestamp", "created", "started"];
const END_KEYS = ["completed_at", "finished_at", "ended_at", "end_time", "completed", "finished", "updated_at", "update_time"];
const RUN_CONTAINER_KEYS = ["runs", "history", "executions", "run_history", "past_runs", "results", "sessions", "jobs", "instances"];
const PARENT_KEYS = ["task_id", "routine_id", "automation_id", "parent_id", "bot_id", "schedule_id"];
const SUMMARY_KEYS = ["summary", "message", "result", "output", "snippet", "description", "error", "title"];
const URL_KEYS = ["url", "link", "href", "permalink", "web_url"];
const PROMPT_KEYS = ["prompt", "instructions", "instruction", "description"];

type Obj = Record<string, unknown>;

export interface NormalizedTask {
  key: string;
  name: string;
  schedule: string | null;
  status: string | null;
  native_url: string | null;
  purpose: string | null;
  raw: Obj;
}
export interface NormalizedRun {
  taskKey: string;
  external_id: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  output_url: string | null;
  raw: Obj;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const firstKey = (o: Obj, keys: string[]) => keys.find((k) => o[k] !== undefined && o[k] !== null && o[k] !== "");
const pick = (o: Obj, keys: string[]) => {
  const k = firstKey(o, keys);
  return k === undefined ? undefined : o[k];
};

function str(v: unknown, max = 300): string | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function toIso(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") {
    const ms = v < 1e11 ? v * 1000 : v; // seconds vs milliseconds
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    if (/^\d{9,13}(\.\d+)?$/.test(v)) return toIso(Number(v));
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function mapRunStatus(v: unknown): RunStatus {
  if (v === true) return "success";
  if (v === false) return "failed";
  const s = String(v ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/(fail|error|errored|crash|timeout|cancel)/.test(s)) return "failed";
  if (/(attention|action[_ ]required|blocked|needs)/.test(s)) return "needs_attention";
  if (/(success|succeeded|complete|completed|done|finished|ok|passed)/.test(s)) return "success";
  if (/(running|in[_ ]progress|pending|queued|started|active|executing|scheduled)/.test(s)) return "running";
  return "unknown";
}

function taskStatus(o: Obj): string | null {
  const k = firstKey(o, STATUS_KEYS);
  if (!k) return null;
  const v = o[k];
  if (k === "enabled" || k === "is_enabled" || k === "active" || k === "is_active") return v ? "active" : "paused";
  if (k === "paused" || k === "is_paused" || k === "disabled") return v ? "paused" : "active";
  return str(v, 60);
}

function looksLikeTask(o: Obj): boolean {
  const id = pick(o, ID_KEYS);
  if (id === undefined || (typeof id !== "string" && typeof id !== "number")) return false;
  const hasName = firstKey(o, NAME_KEYS) !== undefined || firstKey(o, PROMPT_KEYS) !== undefined;
  if (!hasName) return false;
  const hasSchedule = firstKey(o, SCHEDULE_KEYS) !== undefined;
  const hasRuns = RUN_CONTAINER_KEYS.some((k) => Array.isArray(o[k]));
  return hasSchedule || hasRuns;
}

function looksLikeRun(o: Obj): boolean {
  const id = pick(o, RUN_ID_KEYS);
  if (id === undefined || (typeof id !== "string" && typeof id !== "number")) return false;
  const hasStatus = firstKey(o, STATUS_KEYS) !== undefined;
  const hasTime = firstKey(o, [...START_KEYS, ...END_KEYS]) !== undefined;
  return hasStatus && hasTime;
}

function nativeUrl(p: PlatformConfig, o: Obj, key: string): string | null {
  const direct = pick(o, URL_KEYS);
  if (typeof direct === "string" && /^https?:\/\//.test(direct)) return direct;
  if (p.nativeUrlTemplate) return p.nativeUrlTemplate.replaceAll("{{key}}", encodeURIComponent(key));
  return p.tasksUrl || null;
}

function outputUrl(p: PlatformConfig, o: Obj): string | null {
  const direct = pick(o, URL_KEYS);
  if (typeof direct === "string" && /^https?:\/\//.test(direct)) return direct;
  const conv = o["conversation_id"] ?? o["conversationId"];
  if (typeof conv === "string" && p.id === "chatgpt") return `https://chatgpt.com/c/${conv}`;
  return null;
}

function toTask(p: PlatformConfig, o: Obj): NormalizedTask {
  const key = String(pick(o, ID_KEYS));
  const name = str(pick(o, NAME_KEYS) ?? pick(o, PROMPT_KEYS), 200) ?? key;
  const schedule = str(pick(o, SCHEDULE_KEYS), 200);
  return {
    key,
    name,
    schedule,
    status: taskStatus(o),
    native_url: nativeUrl(p, o, key),
    purpose: str(pick(o, PROMPT_KEYS), 500),
    raw: o,
  };
}

function toRun(p: PlatformConfig, o: Obj, taskKey: string): NormalizedRun {
  return {
    taskKey,
    external_id: String(pick(o, RUN_ID_KEYS)),
    status: mapRunStatus(pick(o, STATUS_KEYS)),
    started_at: toIso(pick(o, START_KEYS)),
    finished_at: toIso(pick(o, END_KEYS)),
    summary: str(pick(o, SUMMARY_KEYS), 500),
    output_url: outputUrl(p, o),
    raw: o,
  };
}

export function normalizePayloads(p: PlatformConfig, payloads: unknown[]): { tasks: NormalizedTask[]; runs: NormalizedRun[] } {
  const tasks = new Map<string, NormalizedTask>();
  const runs = new Map<string, NormalizedRun>();
  const orphanRuns: Obj[] = [];

  const visit = (node: unknown, depth: number) => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const o = node as Obj;
    if (looksLikeTask(o)) {
      const t = toTask(p, o);
      if (!tasks.has(t.key)) tasks.set(t.key, t);
      for (const k of RUN_CONTAINER_KEYS) {
        const arr = o[k];
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
          if (isObj(r) && looksLikeRun(r)) {
            const run = toRun(p, r, t.key);
            runs.set(`${t.key}:${run.external_id}`, run);
          }
        }
      }
    } else if (looksLikeRun(o)) {
      const parent = pick(o, PARENT_KEYS) ?? (isObj(o["task"]) ? pick(o["task"] as Obj, ID_KEYS) : undefined);
      if (parent !== undefined) {
        const run = toRun(p, o, String(parent));
        runs.set(`${run.taskKey}:${run.external_id}`, run);
      } else {
        orphanRuns.push(o);
      }
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };

  for (const payload of payloads) visit(payload, 0);

  // Orphan runs whose id space overlaps a known task id are attached to that task.
  for (const o of orphanRuns) {
    const id = String(pick(o, RUN_ID_KEYS));
    for (const key of tasks.keys()) {
      if (id.startsWith(key) || id.includes(key)) {
        const run = toRun(p, o, key);
        runs.set(`${key}:${run.external_id}`, run);
        break;
      }
    }
  }

  return { tasks: [...tasks.values()], runs: [...runs.values()] };
}
