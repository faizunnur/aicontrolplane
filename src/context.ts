import { AsyncLocalStorage } from "node:async_hooks";

/*
  Correlation context for logs (and later traces): whatever is set here rides along every
  awaited call in the same request or job and is stamped onto each log line, so one
  request_id or run_id finds all of its lines. Kept dependency-free: the logger imports this,
  never the other way round.
*/

export type LogContext = Record<string, string | number>;

const als = new AsyncLocalStorage<LogContext>();

/** The context active on this async path, if any. */
export function logContext(): LogContext | undefined {
  return als.getStore();
}

/** Run fn with extra context merged over whatever is already active. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return als.run({ ...als.getStore(), ...ctx }, fn);
}
