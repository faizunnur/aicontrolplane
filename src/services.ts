import { backfillAgents } from "./agents.js";
import { browser } from "./browser/manager.js";
import { pruneOutbox } from "./db.js";
import { startEmailPoller } from "./ingest/email.js";
import { registerJobHandlers, type HandlerScope } from "./jobs.js";
import { queue } from "./queue.js";
import { logger } from "./logger.js";
import { persistEnabled, startPersistLoop } from "./persist.js";
import { recoverInterruptedApprovals, sweepApprovals } from "./policy.js";
import { reapStaleRuns } from "./runs.js";
import { startScheduler } from "./sync.js";

const log = logger("services");

/*
  The executing half of the platform: job handlers, recovery, schedulers, pollers, sweepers
  and the browser. ROLE=all runs this next to the HTTP server; ROLE=worker runs it alone.
  The api role runs none of it — it only enqueues and serves.
*/

export async function startExecutionServices(scope: HandlerScope): Promise<void> {
  registerJobHandlers(scope);
  if (persistEnabled) startPersistLoop();
  if (scope === "core" || scope === "all") {
    try {
      await backfillAgents();
      // Approvals whose run died are closed; parked ones keep waiting. Runs are reaped by
      // silence, not by boot — another executor may be mid-flight.
      const approvals = await recoverInterruptedApprovals();
      if (approvals) log.warn(`recovered after restart: ${approvals} orphaned approval(s) closed`);
    } catch (err) {
      log.error("startup recovery failed", err);
    }
    // In split mode the recurring work fires from the shared queue cron (one firing per
    // interval however many workers run); the single process keeps plain timers.
    if (queue.kind !== "boss") {
      startEmailPoller();
      // Approvals nobody decides expire on a clock (durable timers, not in-memory ones), the
      // outbox event log keeps a bounded replay window, and silent runs are declared dead.
      const sweep = setInterval(() => {
        void sweepApprovals().catch((err) => log.error("approval sweep failed", err));
        void pruneOutbox().catch((err) => log.error("outbox prune failed", err));
        void reapStaleRuns().catch((err) => log.error("stale run reap failed", err));
      }, 60_000);
      sweep.unref?.();
    }
  }
  if (scope === "browser" || scope === "all") {
    // The sync scheduler drives the browser, so it lives with it; the queue cron replaces it in split mode.
    if (queue.kind !== "boss") startScheduler();
    if (browser.enabled) {
      // Warm the browser so the VNC screen shows something immediately.
      browser.getContext().catch((err) => log.error("browser failed to launch", err));
    }
  }
}
