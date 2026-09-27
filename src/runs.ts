import { addRunEvent, cancelRequested, finishRun, foldSteps, getMessage, getRun, listRuns, runEvents, setCancelRequested, startRun, transitionRun, updateMessage, type StartRunInput } from "./db.js";
import { logger } from "./logger.js";
import { ACTIVE_RUN_STATUSES, type Run, type RunStatus, type Step, type StepStatus } from "../packages/core/src/index.js";

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
  const summary = (outcome.error ?? outcome.summary ?? "").slice(0, 200);
  const line = `run #${runId} ${outcome.status}${summary ? `: ${summary}` : ""}${run.started_at ? ` (${Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)}s)` : ""}`;
  if (outcome.status === "failed") log.warn(line);
  else log.info(line);
  // A task run that a chat command started reports back into that message when it ends.
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
 * Runs still marked active from before a restart. Work the control plane executes in-process
 * cannot survive its process, so it is failed honestly; runs that live elsewhere (an external
 * agent reporting through the API) are left alone — their callbacks still arrive.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  let recovered = 0;
  for (const status of ACTIVE_RUN_STATUSES) {
    const stuck = await listRuns({ status, limit: 500 });
    for (const run of stuck) {
      if (run.kind === "external") continue; // executing remotely; the report closes it
      if (run.status === "waiting" || run.status === "waiting_approval") continue; // parked, durable, resumable
      const error = "Interrupted by a server restart.";
      await addRunEvent(run.id, { type: "error", label: "Interrupted", detail: error });
      await transitionRun(run.id, [run.status], "failed", { error });
      if (run.message_id) {
        const m = await getMessage(run.message_id);
        if (m && (m.status === "assigned" || m.status === "delivered")) await updateMessage(m.id, { status: "failed", error });
      }
      recovered++;
    }
  }
  return recovered;
}
