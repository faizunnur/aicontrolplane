import { backfillAgents } from "./agents.js";
import { browser } from "./browser/manager.js";
import { pruneOutbox } from "./db.js";
import { startEmailPoller } from "./ingest/email.js";
import { registerJobHandlers } from "./jobs.js";
import { logger } from "./logger.js";
import { persistEnabled, startPersistLoop } from "./persist.js";
import { recoverInterruptedApprovals, sweepApprovals } from "./policy.js";
import { recoverInterruptedRuns } from "./runs.js";
import { startScheduler } from "./sync.js";

const log = logger("services");

/*
  The executing half of the platform: job handlers, recovery, schedulers, pollers, sweepers
  and the browser. ROLE=all runs this next to the HTTP server; ROLE=worker runs it alone.
  The api role runs none of it — it only enqueues and serves.
*/

export async function startExecutionServices(): Promise<void> {
  registerJobHandlers();
  if (persistEnabled) startPersistLoop();
  try {
    await backfillAgents();
    // Work that was in flight when the last process stopped is surfaced, never left hanging.
    const approvals = await recoverInterruptedApprovals();
    const runs = await recoverInterruptedRuns();
    if (approvals || runs) log.warn(`recovered after restart: ${approvals} orphaned approval(s) closed, ${runs} interrupted run(s) failed`);
  } catch (err) {
    log.error("startup recovery failed", err);
  }
  startScheduler();
  startEmailPoller();
  // Approvals nobody decides expire on a clock (durable timers, not in-memory ones), and the
  // outbox event log keeps a bounded replay window.
  const sweep = setInterval(() => {
    void sweepApprovals().catch((err) => log.error("approval sweep failed", err));
    void pruneOutbox().catch((err) => log.error("outbox prune failed", err));
  }, 60_000);
  sweep.unref?.();
  if (browser.enabled) {
    // Warm the browser so the VNC screen shows something immediately.
    browser.getContext().catch((err) => log.error("browser failed to launch", err));
  }
}
