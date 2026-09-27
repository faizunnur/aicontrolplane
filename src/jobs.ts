import { deliverMessage, deliverToConnection } from "./deliver.js";
import { logger } from "./logger.js";
import { settleDecision } from "./policy.js";
import { JOB, queue, type ChatDeliverJob, type DispatchDeliverJob, type RunResumeJob, type TaskStartJob } from "./queue.js";
import { executeTaskRun } from "./tasks.js";

const log = logger("jobs");

/*
  The job handlers: what an executing process (ROLE=worker, or the single-container ROLE=all)
  does with each queued job. Registering them is what makes a process an executor; the api
  role never calls this, so it only ever enqueues.
*/

let registered = false;
export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;
  queue.work<ChatDeliverJob>(JOB.chatDeliver, async ({ messageId, platformId }) => {
    await deliverToConnection(messageId, platformId);
  });
  queue.work<DispatchDeliverJob>(JOB.dispatchDeliver, async ({ messageId }) => {
    await deliverMessage(messageId);
  });
  queue.work<TaskStartJob>(JOB.taskStart, async ({ runId }) => {
    await executeTaskRun(runId);
  });
  queue.work<RunResumeJob>(JOB.runResume, async ({ runId, approvalId, decision }) => {
    await settleDecision(runId, approvalId, decision);
  });
  log.debug("job handlers registered");
}
