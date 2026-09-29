import { config } from "./config.js";
import { getBrowserOpAnyOrg, getMessageAnyOrg, getRunAnyOrg, pruneBrowserOps, pruneOutbox, pruneUserTokens, systemScope, withOrg } from "./db.js";
import { deliverMessage, deliverToConnection } from "./deliver.js";
import { emailConfigured, pollOnce } from "./ingest/email.js";
import { logger } from "./logger.js";
import { reconcileParkedRuns, settleDecision, sweepApprovals } from "./policy.js";
import { reapStaleRuns } from "./runs.js";
import { syncTick } from "./sync.js";
import { executeBrowserOpJob } from "./browser-ops.js";
import { JOB, queue, type BrowserOpJob, type ChatDeliverJob, type DispatchDeliverJob, type RunResumeJob, type TaskStartJob } from "./queue.js";
import { executeTaskRun, requeueStuckTaskRuns } from "./tasks.js";

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

/*
  A job arrives with a row id and no workspace; the row itself says which workspace it
  belongs to, so the handler peeks (system scope) and adopts it. The row's org is canonical —
  a payload orgId would only ever be a cross-check.
*/
async function adoptRun(runId: number, fn: () => Promise<void>): Promise<void> {
  const row = await systemScope(() => getRunAnyOrg(runId));
  if (!row) return; // the run vanished; nothing to execute
  await withOrg(row.org_id, fn);
}
async function adoptMessage(messageId: number, fn: () => Promise<unknown>): Promise<void> {
  const row = await systemScope(() => getMessageAnyOrg(messageId));
  if (!row) return;
  await withOrg(row.org_id, fn);
}
async function adoptBrowserOp(opId: number, fn: () => Promise<void>): Promise<void> {
  const row = await systemScope(() => getBrowserOpAnyOrg(opId));
  if (!row) return;
  await withOrg(row.org_id, fn);
}

let registered: HandlerScope | null = null;
export function registerJobHandlers(scope: HandlerScope): void {
  if (registered) return;
  registered = scope;
  if (scope === "core" || scope === "all") {
    queue.work<DispatchDeliverJob>(JOB.dispatchDeliver, async ({ messageId }) => {
      await adoptMessage(messageId, () => deliverMessage(messageId));
    });
    queue.work<TaskStartJob>(JOB.taskStart, async ({ runId }) => {
      await adoptRun(runId, () => executeTaskRun(runId));
    });
    queue.work<RunResumeJob>(JOB.runResume, async ({ runId, approvalId, decision }) => {
      await adoptRun(runId, () => settleDecision(runId, approvalId, decision));
    });
    queue.work("cron.maintenance", async () => {
      await sweepApprovals();
      await pruneOutbox();
      await reapStaleRuns();
      await requeueStuckTaskRuns();
      await reconcileParkedRuns();
      await pruneBrowserOps();
      await pruneUserTokens();
    });
    queue.work("cron.email", async () => {
      // The IMAP account is configured at install level; what it ingests belongs to the founding workspace.
      if (emailConfigured()) await withOrg(1, () => pollOnce());
    });
  }
  if (scope === "browser" || scope === "all") {
    queue.work<ChatDeliverJob>(JOB.chatDeliver, async ({ messageId, platformId }) => {
      await adoptMessage(messageId, () => deliverToConnection(messageId, platformId));
    });
    queue.work<DispatchDeliverJob>(JOB.browserDispatchDeliver, async ({ messageId }) => {
      await adoptMessage(messageId, () => deliverMessage(messageId));
    });
    queue.work<RunResumeJob>(JOB.browserRunResume, async ({ runId, approvalId, decision }) => {
      await adoptRun(runId, () => settleDecision(runId, approvalId, decision));
    });
    queue.work<BrowserOpJob>(JOB.browserOp, async ({ opId }) => {
      await adoptBrowserOp(opId, () => executeBrowserOpJob(opId));
    }, { teamSize: 2 });
    queue.work("cron.sync", async () => {
      // The browser serves the founding workspace until the fleet phase fans this out per workspace.
      await withOrg(1, () => syncTick());
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
