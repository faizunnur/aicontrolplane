type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.LOG_LEVEL as Level) || "info";

function fmt(scope: string, level: Level, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + safe(extra);
  return `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
}
function safe(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  const log = (level: Level, msg: string, extra?: unknown) => {
    if (order[level] < order[minLevel]) return;
    const line = fmt(scope, level, msg, extra);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m: string, e?: unknown) => log("debug", m, e),
    info: (m: string, e?: unknown) => log("info", m, e),
    warn: (m: string, e?: unknown) => log("warn", m, e),
    error: (m: string, e?: unknown) => log("error", m, e),
  };
}
