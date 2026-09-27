import { deliverMessage, deliverToConnection } from "./deliver.js";
import { logger } from "./logger.js";
import { settleDecision } from "./policy.js";
import { JOB, queue, type ChatDeliverJob, type DispatchDeliverJob, type RunResumeJob, type TaskStartJob } from "./queue.js";
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
  }
  log.debug(`job handlers registered (${scope})`);
}
