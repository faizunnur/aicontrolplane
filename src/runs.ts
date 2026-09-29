import { hostname } from "node:os";
import { activeRunCount, addRunEvent, cancelRequested, finishRun, foldSteps, getMessage, getRun, heartbeatRun, listStaleRunningRunsAll, orgQuotas, rawAll, rawRun, runCountSince, runEvents, setCancelRequested, startRun, systemScope, transitionRun, updateMessage, withOrg, type StartRunInput } from "./db.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { runsSettled } from "./metrics.js";
import type { Run, RunStatus, Step, StepStatus } from "../packages/core/src/index.js";

const log = logger("runs");

/*
  The run lifecycle. Every piece of work the control plane executes (a chat message, a sync, an
  action, a task started at a provider) is a run with a timeline of run events:

    beginRun  → RunTracker.start/done/fail/waiting …  → endRun

  The tracker folds its own steps in memory (it is the run's only writer while it executes),
  so a step costs one INSERT — the timeline in run_events stays the source of truth. When a
  run belongs to a message, the folded steps are copied onto the message row once, when the
  run settles; while it is live the view folds from run_events directly.

  Cancellation is a column on the run (cancel_requested), so a stop pressed on any instance
  reaches the executing one; the tracker checks it at every step boundary.
*/

export async function requestCancel(runId: number) {
  await setCancelRequested(runId);
}
export async function isCancelled(runId: number): Promise<boolean> {
  return cancelRequested(runId);
}

export class CancelledError extends Error {
  constructor(message = "You stopped it.") {
    super(message);
    this.name = "CancelledError";
  }
}

export class RunTracker {
  /** The folded step view, maintained in memory: this tracker is the run's only writer while it executes. */
  private steps: Step[] | null = null;

  constructor(
    readonly runId: number,
    readonly messageId: number | null = null,
  ) {}

  /** The step view of this run's timeline. Hydrated from run_events once, then folded locally. */
  async read(): Promise<Step[]> {
    if (this.steps === null) this.steps = foldSteps(await runEvents(this.runId));
    return this.steps;
  }

  private fold(key: string, label: string, status: StepStatus, detail: string | null, at: string) {
    const steps = this.steps!;
    const finished = status === "done" || status === "failed" || status === "skipped";
    const cur = steps.find((s) => s.key === key);
    if (!cur) {
      steps.push({ key, label, status, detail, at, ended_at: finished ? at : null });
    } else {
      cur.label = label || cur.label;
      cur.status = status;
      if (detail !== null) cur.detail = detail;
      cur.ended_at = finished ? at : null;
    }
  }

  private async emit(key: string, label: string, status: StepStatus, detail?: string | null) {
    const steps = await this.read();
    const text = label || steps.find((s) => s.key === key)?.label || key;
    const ev = await addRunEvent(this.runId, { type: "step", key, label: text, status, detail: detail ?? null });
    this.fold(key, text, status, detail ?? null, ev.at);
    const line = `run #${this.runId} · ${text} → ${status}${detail ? ` (${detail.slice(0, 160)})` : ""}`;
    if (status === "failed") log.warn(line);
    else log.info(line);
  }

  async set(key: string, label: string, status: StepStatus, detail?: string | null) {
    await this.emit(key, label, status, detail);
  }
  /** Begin a step. Throws CancelledError if the user pressed Stop, so callers unwind naturally. */
  async start(key: string, label: string, detail?: string | null) {
    await this.checkCancel();
    await this.emit(key, label, "running", detail);
  }
  async done(key: string, detail?: string | null) {
    await this.emit(key, "", "done", detail);
  }
  async fail(key: string, detail?: string | null) {
    await this.emit(key, "", "failed", detail);
  }
  async skip(key: string, detail?: string | null) {
    await this.emit(key, "", "skipped", detail);
  }
  async waiting(key: string, label: string, detail?: string | null) {
    await this.emit(key, label, "waiting", detail);
  }
  /** A plain line in the timeline that is not a step. */
  async log(label: string, detail?: string | null) {
    await addRunEvent(this.runId, { type: "log", label, detail: detail ?? null });
  }
  /** Whatever is still running or waiting failed with this reason. */
  async failRunning(detail: string) {
    for (const s of [...(await this.read())]) if (s.status === "running" || s.status === "waiting" || s.status === "pending") await this.emit(s.key, s.label, "failed", detail);
  }
  async checkCancel() {
    if (await isCancelled(this.runId)) throw new CancelledError();
  }
}

/* ---------- the executor's lease: how "worker died" becomes minutes, not half an hour ---------- */

export const RUN_LEASE_TTL_MS = 5 * 60_000;
export const RUN_HEARTBEAT_MS = 60_000;
/** Who holds a lease: this process, named so two workers on one host stay distinct. */
export const leaseOwner = `${hostname()}#${process.pid}`;

/**
 * Run fn with a heartbeat on the run's lease: renewed every minute while the executor works,
 * five minutes of slack before the reaper may call it dead. On the way out the lease is
 * cleared IF the run is still "running" — a run left open on purpose (waiting for an agent's
 * report or a webhook ack) has no local executor anymore, so the legacy 30-minute silence
 * rule judges it instead of a lease nobody renews.
 */
export async function withRunLease<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  await heartbeatRun(runId, RUN_LEASE_TTL_MS, leaseOwner).catch(() => undefined);
  const timer = setInterval(() => void heartbeatRun(runId, RUN_LEASE_TTL_MS, leaseOwner).catch((err) => log.warn(`heartbeat for run #${runId} failed`, err)), RUN_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    // Direct SQL until packages/data grows a clearRunLease(); the run id is a global key.
    await rawRun("UPDATE runs SET lease_expires_at = NULL, locked_by = NULL WHERE id = ? AND status = 'running' AND locked_by = ?", [runId, leaseOwner]).catch(() => undefined);
  }
}

/* ---------- workspace quotas, checked where runs start executing ---------- */

/** A run refused by quota. retryable: the queue should try again later (concurrency); not retryable: fail now (daily cap). */
export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/**
 * Enforce the ambient workspace's run quotas: org row overrides first, env defaults second,
 * 0 meaning unlimited. selfCounted says the run being started already has its own row in an
 * active status (a queued task run), so it must not block itself. Concurrency over the cap
 * throws retryable — the queue's backoff becomes natural queueing; the daily cap throws
 * non-retryable — tomorrow is the only fix.
 */
export async function enforceRunQuotas(opts: { selfCounted?: boolean } = {}): Promise<void> {
  const org = await orgQuotas();
  const maxConcurrent = org.maxConcurrentRuns ?? config.quotas.maxConcurrentRuns;
  const maxDaily = org.maxRunsPerDay ?? config.quotas.maxRunsPerDay;
  const self = opts.selfCounted ? 1 : 0;
  if (maxConcurrent > 0 && (await activeRunCount()) - self >= maxConcurrent) {
    throw new QuotaExceededError("workspace concurrency limit reached — try again shortly", true);
  }
  if (maxDaily > 0) {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    if ((await runCountSince(midnight.toISOString())) - self >= maxDaily) {
      throw new QuotaExceededError(`workspace daily run limit (${maxDaily}) reached — it resets at midnight UTC`, false);
    }
  }
}

/** Start a run and its tracker in one go. */
export async function beginRun(input: StartRunInput): Promise<{ run: Run; track: RunTracker }> {
  const run = await startRun(input);
  log.info(`run #${run.id} started: ${input.kind} "${input.label}" on ${input.provider ?? "the control plane"} (trigger: ${input.trigger ?? "user"}${input.message_id ? `, message ${input.message_id}` : ""}${input.task_id ? `, task ${input.task_id}` : ""})`);
  return { run, track: new RunTracker(run.id, input.message_id ?? null) };
}

/** Close a run. Writes the result event, the final status, and snapshots the steps onto its message. */
export async function endRun(runId: number, outcome: { status: RunStatus; summary?: string | null; error?: string | null; output_url?: string | null; external_id?: string | null }): Promise<Run | undefined> {
  const run = await getRun(runId);
  if (!run) return undefined;
  // A settled run never changes its outcome: a late webhook report or a second finish call
  // must not overwrite what already happened (e.g. flip a failed run to success).
  if (run.status !== "running") {
    log.warn(`run #${runId} is already ${run.status}; ignoring late ${outcome.status} finish`);
    return run;
  }
  const label = outcome.status === "success" ? "Completed" : outcome.status === "cancelled" ? "Stopped" : outcome.status === "failed" ? "Failed" : outcome.status === "needs_attention" ? "Needs attention" : "Finished";
  // Success closes the timeline with a final step; other outcomes leave their mark on the step that failed and add a result line.
  if (outcome.status === "success") await addRunEvent(runId, { type: "step", key: "done", label, status: "done", detail: null });
  else await addRunEvent(runId, { type: outcome.status === "failed" ? "error" : "result", label, detail: outcome.error ?? outcome.summary ?? null });
  // The one snapshot of the folded steps onto the message row, now that the timeline is final.
  if (run.message_id) await updateMessage(run.message_id, { steps: foldSteps(await runEvents(runId)) });
  const finished = await finishRun(runId, outcome);
  if (finished) runsSettled.inc({ status: finished.status, kind: finished.kind });
  const summary = (outcome.error ?? outcome.summary ?? "").slice(0, 200);
  const line = `run #${runId} ${outcome.status}${summary ? `: ${summary}` : ""}${run.started_at ? ` (${Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)}s)` : ""}`;
  if (outcome.status === "failed") log.warn(line);
  else log.info(line);
  // A task run that a chat command started reports back into that message when it ends.
  if (finished?.kind === "task" && finished.message_id) for (const h of afterRunHooks) h(finished.id);
  return finished;
}

/**
 * Settle a parked run (waiting / waiting_approval) that will not continue: rejection, timeout,
 * expiry. Mirrors endRun for runs that are not "running": final event, message snapshot and
 * status, guarded transition.
 */
export async function finishParked(run: Run, status: RunStatus, outcome: { summary?: string | null; error?: string | null }): Promise<Run | undefined> {
  const label = status === "cancelled" ? "Stopped" : status === "timed_out" ? "Timed out" : status === "failed" ? "Failed" : "Finished";
  await addRunEvent(run.id, { type: status === "failed" ? "error" : "result", label, detail: outcome.error ?? outcome.summary ?? null });
  if (run.message_id) {
    await updateMessage(run.message_id, {
      status: status === "cancelled" || status === "timed_out" ? "cancelled" : "failed",
      error: outcome.error ?? null,
      steps: foldSteps(await runEvents(run.id)),
    });
  }
  const finished = await transitionRun(run.id, [run.status], status, { error: outcome.error ?? null, summary: outcome.summary ?? null });
  if (finished) runsSettled.inc({ status: finished.status, kind: finished.kind });
  if (finished?.kind === "task" && finished.message_id) for (const h of afterRunHooks) h(finished.id);
  return finished;
}

const afterRunHooks: ((runId: number) => void)[] = [];
/** Called after any run ends; used by the command layer to settle the message that asked for it. */
export function onRunEnded(hook: (runId: number) => void) {
  afterRunHooks.push(hook);
}

/** The run behind a message, if it has one. */
export async function runForMessage(messageId: number): Promise<Run | undefined> {
  const m = await getMessage(messageId);
  return m?.run_id ? await getRun(m.run_id) : undefined;
}

/**
 * Fail running runs whose executor died — in two tiers. A run WITH a lease is declared dead
 * the moment its lease expires unrenewed (heartbeats come every minute with five minutes of
 * slack, so "worker died" is caught in ~5 minutes). A run with NO lease — an open-on-purpose
 * run waiting for an agent's report, or one from before leases — keeps the legacy rule: a
 * timeline silent past the threshold, far beyond any legitimate quiet stretch. External runs
 * are never touched: their agents report in on their own schedule.
 */
export const STALE_RUN_MS = 30 * 60_000;
export async function reapStaleRuns(staleMs = STALE_RUN_MS): Promise<number> {
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  // Direct SQL until packages/data grows a listExpiredLeaseRunsAll(); ids are global keys.
  const leaseDead = await rawAll<Run & { org_id: number }>("SELECT * FROM runs WHERE status = 'running' AND kind != 'external' AND lease_expires_at IS NOT NULL AND lease_expires_at < ? LIMIT 100", [nowIso]);
  // The silence rule applies only where no lease speaks: an actively leased run may sit
  // quietly for ages (a long reply wait) without being anyone's leftovers.
  const silent = (await systemScope(() => listStaleRunningRunsAll(cutoff))).filter((r) => !r.lease_expires_at);
  const seen = new Set<number>();
  let reaped = 0;
  // The worklist spans every workspace; each run is then repaired inside its own, so the
  // failure event and message update land where they belong.
  for (const run of [...leaseDead, ...silent]) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    reaped += await withOrg(run.org_id, async () => {
      // One more look before the kill: the worker may have heartbeat between list and now.
      const fresh = await getRun(run.id);
      if (!fresh || fresh.status !== "running") return 0;
      if (fresh.lease_expires_at && fresh.lease_expires_at >= nowIso) return 0; // renewed — alive after all
      const error = run.lease_expires_at ? "Its worker stopped heartbeating; the run was abandoned." : "Its process stopped answering; the run was abandoned.";
      const failed = await transitionRun(run.id, ["running"], "failed", { error });
      if (!failed) return 0; // it moved on its own — alive after all
      await addRunEvent(run.id, { type: "error", label: "Abandoned", detail: error });
      if (run.message_id) {
        const m = await getMessage(run.message_id);
        if (m && (m.status === "assigned" || m.status === "delivered")) await updateMessage(m.id, { status: "failed", error });
      }
      return 1;
    });
  }
  if (reaped) log.warn(`reaped ${reaped} stale run(s)`);
  return reaped;
}
