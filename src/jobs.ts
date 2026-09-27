import { config } from "./config.js";
import { pruneBrowserOps, pruneOutbox } from "./db.js";
import { deliverMessage, deliverToConnection } from "./deliver.js";
import { emailConfigured, pollOnce } from "./ingest/email.js";
import { logger } from "./logger.js";
import { settleDecision, sweepApprovals } from "./policy.js";
import { reapStaleRuns } from "./runs.js";
import { syncTick } from "./sync.js";
import { executeBrowserOpJob } from "./browser-ops.js";
import { JOB, queue, type BrowserOpJob, type ChatDeliverJob, type DispatchDeliverJob, type RunResumeJob, type TaskStartJob } from "./queue.js";
import { executeTaskRun } from "./tasks.js";

const log = logger("jobs");

/*
  The job handlers, in two sets:
    core     — everything that never touches Chrome: task starts (API/webhook fires),
               webhook/inbox dispatches, task-kind resumes.
    browser  — everything that may drive Chrome: chat deliveries, browser-mode dispatches,
               chat/dispatch/action resumes.
  ROLE=worker registers core, ROLE=browser registers browser, ROLE=all registers both.
  Registering is what makes a process claim; the api role registers nothing.
*/

export type HandlerScope = "core" | "browser" | "all";

let registered: HandlerScope | null = null;
export function registerJobHandlers(scope: HandlerScope): void {
  if (registered) return;
  registered = scope;
  if (scope === "core" || scope === "all") {
    queue.work<DispatchDeliverJob>(JOB.dispatchDeliver, async ({ messageId }) => {
      await deliverMessage(messageId);
    });
    queue.work<TaskStartJob>(JOB.taskStart, async ({ runId }) => {
      await executeTaskRun(runId);
    });
    queue.work<RunResumeJob>(JOB.runResume, async ({ runId, approvalId, decision }) => {
      await settleDecision(runId, approvalId, decision);
    });
    queue.work("cron.maintenance", async () => {
      await sweepApprovals();
      await pruneOutbox();
      await reapStaleRuns();
      await pruneBrowserOps();
    });
    queue.work("cron.email", async () => {
      if (emailConfigured()) await pollOnce();
    });
  }
  if (scope === "browser" || scope === "all") {
    queue.work<ChatDeliverJob>(JOB.chatDeliver, async ({ messageId, platformId }) => {
      await deliverToConnection(messageId, platformId);
    });
    queue.work<DispatchDeliverJob>(JOB.browserDispatchDeliver, async ({ messageId }) => {
      await deliverMessage(messageId);
    });
    queue.work<RunResumeJob>(JOB.browserRunResume, async ({ runId, approvalId, decision }) => {
      await settleDecision(runId, approvalId, decision);
    });
    queue.work<BrowserOpJob>(JOB.browserOp, async ({ opId }) => {
      await executeBrowserOpJob(opId);
    }, { teamSize: 2 });
    queue.work("cron.sync", async () => {
      await syncTick();
    });
  }
  log.debug(`job handlers registered (${scope})`);
}

/**
 * Put the recurring work on the shared cron — once per interval however many processes run.
 * Split mode only (the queue must be started first); single-process keeps its local timers.
 */
export async function scheduleCrons(scope: HandlerScope): Promise<void> {
  if (queue.kind !== "boss") return;
  if (scope === "core" || scope === "all") {
    await queue.schedule("cron.maintenance", "* * * * *");
    await queue.schedule("cron.email", `*/${Math.min(Math.max(config.email.pollMin, 1), 59)} * * * *`);
  }
  if (scope === "browser" || scope === "all") {
    await queue.schedule("cron.sync", `*/${Math.min(Math.max(config.sync.intervalMin, 1), 59)} * * * *`);
  }
  log.info(`recurring work scheduled on the queue cron (${scope})`);
}
