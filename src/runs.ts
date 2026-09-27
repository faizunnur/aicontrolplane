import { addRunEvent, finishRun, foldSteps, getMessage, getRun, listRuns, runEvents, startRun, updateMessage, type StartRunInput } from "./db.js";
import { logger } from "./logger.js";
import type { Run, RunStatus, Step, StepStatus } from "../packages/core/src/index.js";

const log = logger("runs");

/*
  The run lifecycle. Every piece of work the control plane executes (a chat message, a sync, an
  action, a task started at a provider) is a run with a timeline of run events:

    beginRun  → RunTracker.start/done/fail/waiting …  → endRun

  Steps are events keyed by name; the latest event per key is the step's state. When a run belongs
  to a message, the folded steps are mirrored onto the message row so the current thread UI keeps
  working; run_events is the source of truth.
*/

const cancelRequested = new Set<number>();

export function requestCancel(runId: number) {
  cancelRequested.add(runId);
}
export function isCancelled(runId: number) {
  return cancelRequested.has(runId);
}
export function clearCancel(runId: number) {
  cancelRequested.delete(runId);
}

export class CancelledError extends Error {
  constructor(message = "You stopped it.") {
    super(message);
    this.name = "CancelledError";
  }
}

export class RunTracker {
  constructor(
    readonly runId: number,
    readonly messageId: number | null = null,
  ) {}

  /** The step view of this run's timeline. */
  async read(): Promise<Step[]> {
    return foldSteps(await runEvents(this.runId));
  }

  private async emit(key: string, label: string, status: StepStatus, detail?: string | null) {
    const text = label || (await this.read()).find((s) => s.key === key)?.label || key;
    await addRunEvent(this.runId, { type: "step", key, label: text, status, detail: detail ?? null });
    const line = `run #${this.runId} · ${text} → ${status}${detail ? ` (${detail.slice(0, 160)})` : ""}`;
    if (status === "failed") log.warn(line);
    else log.info(line);
    await this.mirror();
  }

  /** Keep messages.steps equal to the folded timeline while the thread UI still reads it. */
  private async mirror() {
    if (this.messageId) await updateMessage(this.messageId, { steps: await this.read() });
  }

  async set(key: string, label: string, status: StepStatus, detail?: string | null) {
    await this.emit(key, label, status, detail);
  }
  /** Begin a step. Throws CancelledError if the user pressed Stop, so callers unwind naturally. */
  async start(key: string, label: string, detail?: string | null) {
    this.checkCancel();
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
    for (const s of await this.read()) if (s.status === "running" || s.status === "waiting" || s.status === "pending") await this.emit(s.key, s.label, "failed", detail);
  }
  checkCancel() {
    if (isCancelled(this.runId)) throw new CancelledError();
  }
}

/** Start a run and its tracker in one go. */
export async function beginRun(input: StartRunInput): Promise<{ run: Run; track: RunTracker }> {
  const run = await startRun(input);
  clearCancel(run.id);
  log.info(`run #${run.id} started: ${input.kind} "${input.label}" on ${input.provider ?? "the control plane"} (trigger: ${input.trigger ?? "user"}${input.message_id ? `, message ${input.message_id}` : ""}${input.task_id ? `, task ${input.task_id}` : ""})`);
  return { run, track: new RunTracker(run.id, input.message_id ?? null) };
}

/** Close a run. Writes the result event, the final status, and clears any cancel flag. */
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
  if (run.message_id && outcome.status === "success") await updateMessage(run.message_id, { steps: foldSteps(await runEvents(runId)) });
  clearCancel(runId);
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

/** Runs still marked running from before a restart cannot be resumed; say so instead of leaving them spinning forever. */
export async function recoverInterruptedRuns(): Promise<number> {
  const stuck = await listRuns({ status: "running", limit: 500 });
  for (const run of stuck) {
    const error = "Interrupted by a server restart.";
    await addRunEvent(run.id, { type: "error", label: "Interrupted", detail: error });
    await finishRun(run.id, { status: "failed", error });
    if (run.message_id) {
      const m = await getMessage(run.message_id);
      if (m && (m.status === "assigned" || m.status === "delivered")) await updateMessage(m.id, { status: "failed", error });
    }
  }
  return stuck.length;
}
