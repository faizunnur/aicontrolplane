import { addRunEvent, finishRun, foldSteps, getMessage, getRun, listRuns, runEvents, startRun, updateMessage, type StartRunInput } from "./db.js";
import { logger } from "./logger.js";
import type { Run, RunStatus, Step, StepStatus } from "./types.js";

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
  read(): Step[] {
    return foldSteps(runEvents(this.runId));
  }

  private emit(key: string, label: string, status: StepStatus, detail?: string | null) {
    const text = label || this.read().find((s) => s.key === key)?.label || key;
    addRunEvent(this.runId, { type: "step", key, label: text, status, detail: detail ?? null });
    const line = `run #${this.runId} · ${text} → ${status}${detail ? ` (${detail.slice(0, 160)})` : ""}`;
    if (status === "failed") log.warn(line);
    else log.info(line);
    this.mirror();
  }

  /** Keep messages.steps equal to the folded timeline while the thread UI still reads it. */
  private mirror() {
    if (this.messageId) updateMessage(this.messageId, { steps: this.read() });
  }

  set(key: string, label: string, status: StepStatus, detail?: string | null) {
    this.emit(key, label, status, detail);
  }
  /** Begin a step. Throws CancelledError if the user pressed Stop, so callers unwind naturally. */
  start(key: string, label: string, detail?: string | null) {
    this.checkCancel();
    this.emit(key, label, "running", detail);
  }
  done(key: string, detail?: string | null) {
    this.emit(key, "", "done", detail);
  }
  fail(key: string, detail?: string | null) {
    this.emit(key, "", "failed", detail);
  }
  skip(key: string, detail?: string | null) {
    this.emit(key, "", "skipped", detail);
  }
  waiting(key: string, label: string, detail?: string | null) {
    this.emit(key, label, "waiting", detail);
  }
  /** A plain line in the timeline that is not a step. */
  log(label: string, detail?: string | null) {
    addRunEvent(this.runId, { type: "log", label, detail: detail ?? null });
  }
  /** Whatever is still running or waiting failed with this reason. */
  failRunning(detail: string) {
    for (const s of this.read()) if (s.status === "running" || s.status === "waiting" || s.status === "pending") this.emit(s.key, s.label, "failed", detail);
  }
  checkCancel() {
    if (isCancelled(this.runId)) throw new CancelledError();
  }
}

/** Start a run and its tracker in one go. */
export function beginRun(input: StartRunInput): { run: Run; track: RunTracker } {
  const run = startRun(input);
  clearCancel(run.id);
  log.info(`run #${run.id} started: ${input.kind} "${input.label}" on ${input.provider ?? "the control plane"} (trigger: ${input.trigger ?? "user"}${input.message_id ? `, message ${input.message_id}` : ""}${input.task_id ? `, task ${input.task_id}` : ""})`);
  return { run, track: new RunTracker(run.id, input.message_id ?? null) };
}

/** Close a run. Writes the result event, the final status, and clears any cancel flag. */
export function endRun(runId: number, outcome: { status: RunStatus; summary?: string | null; error?: string | null; output_url?: string | null; external_id?: string | null }): Run | undefined {
  const label = outcome.status === "success" ? "Completed" : outcome.status === "cancelled" ? "Stopped" : outcome.status === "failed" ? "Failed" : outcome.status === "needs_attention" ? "Needs attention" : "Finished";
  // Success closes the timeline with a final step; other outcomes leave their mark on the step that failed and add a result line.
  if (outcome.status === "success") addRunEvent(runId, { type: "step", key: "done", label, status: "done", detail: null });
  else addRunEvent(runId, { type: outcome.status === "failed" ? "error" : "result", label, detail: outcome.error ?? outcome.summary ?? null });
  const run = getRun(runId);
  if (run?.message_id && outcome.status === "success") updateMessage(run.message_id, { steps: foldSteps(runEvents(runId)) });
  clearCancel(runId);
  const finished = finishRun(runId, outcome);
  const summary = (outcome.error ?? outcome.summary ?? "").slice(0, 200);
  const line = `run #${runId} ${outcome.status}${summary ? `: ${summary}` : ""}${run?.started_at ? ` (${Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)}s)` : ""}`;
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
export function runForMessage(messageId: number): Run | undefined {
  const m = getMessage(messageId);
  return m?.run_id ? getRun(m.run_id) : undefined;
}

/** Runs still marked running from before a restart cannot be resumed; say so instead of leaving them spinning forever. */
export function recoverInterruptedRuns(): number {
  const stuck = listRuns({ status: "running", limit: 500 });
  for (const run of stuck) {
    const error = "Interrupted by a server restart.";
    addRunEvent(run.id, { type: "error", label: "Interrupted", detail: error });
    finishRun(run.id, { status: "failed", error });
    if (run.message_id) {
      const m = getMessage(run.message_id);
      if (m && (m.status === "assigned" || m.status === "delivered")) updateMessage(m.id, { status: "failed", error });
    }
  }
  return stuck.length;
}
