import { config } from "./config.js";
import { logger } from "./logger.js";
import { BossQueue, InlineQueue, type Queue } from "../packages/queue/src/index.js";

export { JOB, resumeJobFor, type BrowserOpJob, type ChatDeliverJob, type DispatchDeliverJob, type RunResumeJob, type TaskStartJob } from "../packages/queue/src/index.js";

const log = logger("queue");

/*
  The process's queue: inline (execute-on-send) in the single-container mode, pg-boss when
  the roles split. A failed job logs here and settles its own run; the sender never sees it.
*/

const onError = (name: string, err: unknown) => log.error(`job ${name} failed`, err);

const engine: Queue = config.role === "all" || config.db.driver !== "pg" ? new InlineQueue(onError) : new BossQueue(config.db.url, onError);

if (config.role !== "all" && config.db.driver !== "pg") {
  log.warn(`ROLE=${config.role} needs Postgres for the shared queue; DATABASE_URL is not set, so this process runs the inline queue and cannot share work`);
}

// The inline engine executes on send, so its handlers must exist wherever a send can happen —
// including a process (or test) that never booted the server. Loaded lazily to avoid the
// import cycle (jobs → deliver/tasks/policy → queue).
let handlersLoaded = false;
async function ensureInlineHandlers(): Promise<void> {
  if (handlersLoaded || engine.kind !== "inline") return;
  handlersLoaded = true;
  (await import("./jobs.js")).registerJobHandlers("all");
}

export const queue: Queue = {
  kind: engine.kind,
  async send(name, data, opts) {
    await ensureInlineHandlers();
    return engine.send(name, data, opts);
  },
  work: (name, handler, opts) => engine.work(name, handler, opts),
  start: () => engine.start(),
  stop: () => engine.stop(),
};
