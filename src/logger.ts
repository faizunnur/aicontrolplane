import pino from "pino";
import { bus } from "./bus.js";
import { logContext, type LogContext } from "./context.js";

/*
  Logging that is useful from inside the product, not only in the host's console:
    - every line is printed to stdout at or above LOG_LEVEL (info by default): as structured
      JSON (pino) in production, as readable text in development. LOG_FORMAT=json|pretty overrides.
    - correlation fields from the active context (request_id, run_id, ...) are stamped onto
      every line, so one id finds all of a request's or run's lines
    - every line at debug and above is kept in a ring buffer (the last 2000) and announced on
      the bus, so the Logs view can tail the server live and show more than the console did
    - the console level can be changed at runtime (PUT /api/logs/level) without a redeploy
*/

export type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS = new Set<string>(Object.keys(order));

let consoleLevel: Level = LEVELS.has(process.env.LOG_LEVEL ?? "") ? (process.env.LOG_LEVEL as Level) : "info";

const structured = (process.env.LOG_FORMAT || (process.env.NODE_ENV === "production" ? "json" : "pretty")) === "json";
const sink = pino({
  level: consoleLevel,
  base: undefined, // no pid/hostname noise; the platform's log collector adds its own
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: "msg",
});

export interface LogLine {
  id: number;
  at: string;
  level: Level;
  scope: string;
  msg: string;
  extra: string | null;
  /** Correlation fields captured from the active context (request_id, run_id, ...). */
  ctx?: LogContext;
}

const RING = 2000;
const ring: LogLine[] = [];
let seq = 0;

function safe(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fmt(l: LogLine) {
  const ctx = l.ctx && Object.keys(l.ctx).length ? " " + Object.entries(l.ctx).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  return `${l.at} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.msg}${l.extra ? " " + l.extra : ""}${ctx}`;
}

function record(level: Level, scope: string, msg: string, extra?: unknown): LogLine {
  const ctx = logContext();
  const line: LogLine = {
    id: ++seq,
    at: new Date().toISOString(),
    level,
    scope,
    msg,
    extra: extra === undefined ? null : safe(extra).slice(0, 4000),
    ...(ctx && Object.keys(ctx).length ? { ctx } : {}),
  };
  ring.push(line);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  if (order[level] >= order[consoleLevel]) {
    if (structured) sink[level]({ scope, ...(line.ctx ?? {}), ...(line.extra !== null ? { extra: line.extra } : {}) }, msg);
    else {
      const text = fmt(line);
      if (level === "error") console.error(text);
      else if (level === "warn") console.warn(text);
      else console.log(text);
    }
  }
  // Announced after printing; the live stream forwards it to any open Logs view.
  try {
    bus.emit("log", line);
  } catch {
    /* a listener failing must never break logging */
  }
  return line;
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => void record("debug", scope, m, e),
    info: (m: string, e?: unknown) => void record("info", scope, m, e),
    warn: (m: string, e?: unknown) => void record("warn", scope, m, e),
    error: (m: string, e?: unknown) => void record("error", scope, m, e),
  };
}

/** The newest lines first, filtered by level (that level and above), scope, and a cursor. */
export function recentLogs(opts: { limit?: number; level?: Level; scope?: string; after?: number } = {}): LogLine[] {
  const min = order[opts.level ?? "debug"];
  const out: LogLine[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < Math.min(opts.limit ?? 500, RING); i--) {
    const l = ring[i];
    if (opts.after !== undefined && l.id <= opts.after) break;
    if (order[l.level] < min) continue;
    if (opts.scope && l.scope !== opts.scope) continue;
    out.push(l);
  }
  return out.reverse();
}

export function logLevel(): Level {
  return consoleLevel;
}
export function setLogLevel(level: string): Level {
  if (!LEVELS.has(level)) throw Object.assign(new Error("level must be debug, info, warn or error"), { status: 400 });
  consoleLevel = level as Level;
  sink.level = consoleLevel;
  record("info", "log", `console log level set to ${level}`);
  return consoleLevel;
}
export function logScopes(): string[] {
  return [...new Set(ring.map((l) => l.scope))].sort();
}
