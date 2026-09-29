import { config } from "./config.js";
import { getBrowserOpAnyOrg, getMessage, getMessageAnyOrg, getRun, getRunAnyOrg, getTask, listBrowserSessionOrgsAll, pruneBrowserOps, pruneOutbox, pruneRetention, pruneUserTokens, rawAll, stuckMessages, systemScope, updateMessage, withOrg } from "./db.js";
import { deliverMessage, deliverToConnection, resolveMode } from "./deliver.js";
import { emailConfigured, pollOnce } from "./ingest/email.js";
import { logger } from "./logger.js";
import { reconcileParkedRuns, settleDecision, sweepApprovals } from "./policy.js";
import { reapStaleRuns } from "./runs.js";
import { syncProvider, syncTick } from "./sync.js";
import { refreshPlatformsNow, syncablePlatforms } from "./platforms.js";
import { getProvider } from "./providers/registry.js";
import { executeBrowserOpJob } from "./browser-ops.js";
import { JOB, queue, type BrowserOpJob, type BrowserSyncJob, type ChatDeliverJob, type DispatchDeliverJob, type RunResumeJob, type TaskStartJob } from "./queue.js";
import { executeTaskRun, requeueStuckTaskRuns } from "./tasks.js";
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES, type Suggestion } from "../packages/core/src/index.js";

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

/*
  The idempotency guard for delivery retries. A deliver job can be redelivered — a retry
  after a throw, an expired claim whose first handler is still (or was) running — and the
  provider must not hear the message twice. The message row is the ledger: an attempt that
  got a run going (or finished one successfully) already spoke for this message, so a
  redelivery has nothing to add. A failed or cancelled prior run does NOT block: that is
  precisely what a retry (or a person pressing send again) is for.
*/
async function deliveryAlreadyHandled(messageId: number, platformId?: string): Promise<boolean> {
  const m = await getMessage(messageId);
  if (!m?.run_id) return false;
  const run = await getRun(m.run_id);
  if (!run) return false;
  if (ACTIVE_RUN_STATUSES.includes(run.status)) return true;
  return run.status === "success" && (!platformId || run.provider === platformId);
}

/** Every workspace id — the maintenance fan-out list. Direct SQL until packages/data grows a listOrgIdsAll(). */
async function allOrgIds(): Promise<number[]> {
  return (await rawAll<{ id: number }>("SELECT id FROM orgs ORDER BY id")).map((r) => r.id);
}

/*
  The stuck-delivery sweep. A deliver job that never ran (a crashed send, a lost queue row)
  leaves its message in a pre-delivery status with no run to reap — before this sweep, that
  was forever. Each pass: messages stuck past the cutoff whose run is not alive are either
  settled from their terminal run, re-enqueued (up to the attempt cap, counted in the
  message's routing JSON — messages have no meta column yet), or failed with an error a
  person can act on. Messages still waiting for the user to pick a destination are not
  stuck and are left alone.
*/
const STUCK_MESSAGE_MS = 10 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_FAILED_ERROR = "delivery could not be completed — send it again";

const parseJson = (s: string | null): Record<string, unknown> => {
  try {
    const v = s ? JSON.parse(s) : null;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export async function sweepStuckDeliveries(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_MESSAGE_MS).toISOString();
  let handled = 0;
  for (const orgId of await allOrgIds()) {
    handled += await withOrg(orgId, async () => {
      let n = 0;
      for (const m of await stuckMessages(cutoff)) {
        const run = m.run_id ? await getRun(m.run_id) : undefined;
        if (run && ACTIVE_RUN_STATUSES.includes(run.status)) continue; // parked or waiting: alive, just slow
        if (run && TERMINAL_RUN_STATUSES.includes(run.status)) {
          // The run settled but the message update was lost (a crash in the two-write window):
          // repair the message from the run's outcome instead of delivering again.
          const status = run.status === "success" ? "done" : run.status === "cancelled" || run.status === "timed_out" ? "cancelled" : "failed";
          await updateMessage(m.id, { status, error: run.error ?? null, response: status === "done" ? m.response ?? run.summary : m.response });
          n++;
          continue;
        }
        // No run at all: the deliver job was lost before it created one. Work out where it
        // was headed — but only if it WAS headed somewhere; an unrouted message is the
        // user's decision to make, not ours to force.
        const routing = parseJson(m.routing);
        const attempts = typeof routing.delivery_attempts === "number" ? routing.delivery_attempts : 0;
        let job: { name: string; data: ChatDeliverJob | DispatchDeliverJob } | null = null;
        if (m.task_id) {
          const task = await getTask(m.task_id);
          if (task) job = { name: resolveMode(task) === "browser" ? JOB.browserDispatchDeliver : JOB.dispatchDeliver, data: { messageId: m.id } };
        } else {
          const dispatched = routing.method === "manual" || (typeof routing.confidence === "number" && routing.confidence >= config.router.autoThreshold);
          if (!dispatched) continue; // still in the user's court
          const platform = m.platform ?? topSuggestedPlatform(m.suggestions);
          if (platform) job = { name: JOB.chatDeliver, data: { messageId: m.id, platformId: platform } };
        }
        if (!job || attempts >= MAX_DELIVERY_ATTEMPTS) {
          await updateMessage(m.id, { status: "failed", error: DELIVERY_FAILED_ERROR });
          log.warn(`message ${m.id} stuck in ${m.status} ${job ? `after ${attempts} redeliveries` : "with no recoverable destination"}; marked failed`);
          n++;
          continue;
        }
        await updateMessage(m.id, { routing: { ...routing, delivery_attempts: attempts + 1 } });
        await queue.send(job.name, job.data, { singletonKey: `redeliver:${m.id}:${attempts + 1}` });
        log.warn(`message ${m.id} stuck in ${m.status}; re-enqueued ${job.name} (attempt ${attempts + 1} of ${MAX_DELIVERY_ATTEMPTS})`);
        n++;
      }
      return n;
    });
  }
  return handled;
}

/** The router's best guess, when the message itself does not yet name a provider. */
function topSuggestedPlatform(raw: string | null): string | null {
  const list = ((): Suggestion[] => {
    try {
      const v = raw ? JSON.parse(raw) : null;
      return Array.isArray(v) ? (v as Suggestion[]) : [];
    } catch {
      return [];
    }
  })();
  const top = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  return top?.platform ?? null;
}

/*
  Retention, on the maintenance cron but at its own hourly pace: each workspace's aged-out
  timeline events, notifications, audit and sync-log rows, and the raw payloads on
  long-settled runs. The windows come from config (0 disables a table); the deleted counts
  are logged so an operator can see retention actually working.
*/
let lastRetentionAt = 0;
export async function pruneRetentionTick(force = false): Promise<void> {
  if (!force && Date.now() - lastRetentionAt < 60 * 60_000) return;
  lastRetentionAt = Date.now();
  const r = config.retention;
  const opts = {
    runEventsDays: r.runEventsDays > 0 ? r.runEventsDays : undefined,
    eventsDays: r.eventsDays > 0 ? r.eventsDays : undefined,
    auditDays: r.auditDays > 0 ? r.auditDays : undefined,
    syncLogDays: r.syncLogDays > 0 ? r.syncLogDays : undefined,
    stripRawDays: r.rawDays > 0 ? r.rawDays : undefined,
  };
  if (Object.values(opts).every((v) => v === undefined)) return;
  for (const orgId of await allOrgIds()) {
    const counts = await withOrg(orgId, () => pruneRetention(opts));
    const pruned = Object.entries(counts).filter(([, v]) => v > 0);
    if (pruned.length) log.info(`retention: workspace ${orgId} pruned ${pruned.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
}

let registered: HandlerScope | null = null;
export function registerJobHandlers(scope: HandlerScope): void {
  if (registered) return;
  registered = scope;
  if (scope === "core" || scope === "all") {
    queue.work<DispatchDeliverJob>(JOB.dispatchDeliver, async ({ messageId }) => {
      await adoptMessage(messageId, async () => {
        if (await deliveryAlreadyHandled(messageId)) return log.info(`dispatch of message ${messageId} already handled; skipping redelivery`);
        return deliverMessage(messageId);
      });
    });
    queue.work<TaskStartJob>(JOB.taskStart, async ({ runId }) => {
      await adoptRun(runId, () => executeTaskRun(runId));
    });
    queue.work<RunResumeJob>(JOB.runResume, async ({ runId, approvalId, decision }) => {
      await adoptRun(runId, () => settleDecision(runId, approvalId, decision));
    });
    // Runs once per interval fleet-wide: pg-boss's cron fires one job per schedule, whoever
    // claims it (single-process keeps its local timer). Everything in here must stay
    // idempotent and cheap when there is nothing to do.
    queue.work("cron.maintenance", async () => {
      await sweepApprovals();
      await pruneOutbox();
      await reapStaleRuns();
      await requeueStuckTaskRuns();
      await sweepStuckDeliveries();
      await reconcileParkedRuns();
      await pruneBrowserOps();
      await pruneUserTokens();
      await pruneRetentionTick();
    });
    queue.work("cron.email", async () => {
      // The IMAP account is configured at install level; what it ingests belongs to the founding workspace.
      if (emailConfigured()) await withOrg(1, () => pollOnce());
    });
  }
  if (scope === "browser" || scope === "all") {
    // How many browser jobs run at once. The ephemeral fleet holds maxContexts contexts, so
    // claiming fewer jobs than that leaves paid-for contexts idle; the legacy browser is ONE
    // profile whose lock serialises everything, so extra claimed jobs would only sit on the
    // lock burning their expire clock.
    const browserTeam = config.fleet.mode === "ephemeral" ? Math.max(1, config.fleet.maxContexts) : 1;
    queue.work<ChatDeliverJob>(JOB.chatDeliver, async ({ messageId, platformId }) => {
      await adoptMessage(messageId, async () => {
        if (await deliveryAlreadyHandled(messageId, platformId)) return log.info(`chat delivery of message ${messageId} already handled; skipping redelivery`);
        return deliverToConnection(messageId, platformId);
      });
    }, { teamSize: browserTeam });
    queue.work<DispatchDeliverJob>(JOB.browserDispatchDeliver, async ({ messageId }) => {
      await adoptMessage(messageId, async () => {
        if (await deliveryAlreadyHandled(messageId)) return log.info(`dispatch of message ${messageId} already handled; skipping redelivery`);
        return deliverMessage(messageId);
      });
    }, { teamSize: browserTeam });
    queue.work<RunResumeJob>(JOB.browserRunResume, async ({ runId, approvalId, decision }) => {
      await adoptRun(runId, () => settleDecision(runId, approvalId, decision));
    });
    queue.work<BrowserOpJob>(JOB.browserOp, async ({ opId }) => {
      await adoptBrowserOp(opId, () => executeBrowserOpJob(opId));
    }, { teamSize: 2 });
    queue.work<BrowserSyncJob>(JOB.browserSyncPlatform, async ({ orgId, platformId }) => {
      await withOrg(orgId, async () => {
        let adapter = getProvider(platformId);
        if (!adapter) {
          await refreshPlatformsNow(); // this worker may not have seen the workspace's provider yet
          adapter = getProvider(platformId);
        }
        if (adapter) await syncProvider(adapter);
      });
    }, { teamSize: browserTeam });
    queue.work("cron.sync", async () => {
      if (config.fleet.mode !== "ephemeral") {
        // The legacy browser serves the founding workspace only.
        await withOrg(1, () => syncTick());
        return;
      }
      // Fleet: one look per (workspace, provider), deduped and jittered so a slow pass never
      // stacks on itself and the fan-out does not stampede the context pool.
      for (const orgId of await systemScope(() => listBrowserSessionOrgsAll())) {
        await withOrg(orgId, async () => {
          await refreshPlatformsNow();
          for (const p of syncablePlatforms()) {
            await queue.send<BrowserSyncJob>(JOB.browserSyncPlatform, { orgId, platformId: p.id }, { singletonKey: `sync:${orgId}:${p.id}`, startAfterSeconds: Math.floor(Math.random() * 90) });
          }
        });
      }
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
