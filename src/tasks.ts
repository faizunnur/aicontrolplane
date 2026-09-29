import { ensureTaskAgent } from "./agents.js";
import { config } from "./config.js";
import { withLogContext } from "./context.js";
import { findRunByIdempotencyKey, getAgentProfile, getRun, getTask, listRuns, listStuckQueuedRunsAll, listTasks, recentStatusesByTask, systemScope, transitionRun, withOrg, type TaskWithLastRun } from "./db.js";
import { JOB, queue, type TaskStartJob } from "./queue.js";
import { logger } from "./logger.js";
import { ApprovalPending, guard, registerResumer } from "./policy.js";
import { getProvider } from "./providers/registry.js";
import type { ProviderAdapter, TaskRef } from "./providers/types.js";
import { beginRun, endRun, enforceRunQuotas, finishParked, isCancelled, QuotaExceededError, RunTracker, withRunLease } from "./runs.js";
import type { Run, RunTrigger } from "../packages/core/src/index.js";

const log = logger("tasks");

/*
  The task registry: every standing piece of work across every provider, in one shape, with what
  the control plane can do about each one. The provider adapter answers "can this be started?";
  policy answers "may it?"; a run records that it was.
*/

const parse = (s: string | null): Record<string, unknown> => {
  try {
    const v = s ? JSON.parse(s) : null;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export function taskRef(t: { id: number; key: string; name: string; configuration: string | null; delivery: string | null }): TaskRef {
  return { id: t.id, key: t.key, name: t.name, configuration: { ...parse(t.configuration), delivery: parse(t.delivery) } };
}

export async function taskView(t: TaskWithLastRun, recent: Record<number, string[]> = {}) {
  const adapter = getProvider(t.platform);
  const agent = t.agent_id ? await getAgentProfile(t.agent_id) : undefined;
  const current = (await listRuns({ task_id: t.id, status: "running", limit: 1 }))[0] ?? null;
  const can = adapter ? adapter.canRunTask(taskRef(t)) : { ok: false, reason: "unknown provider" };
  const caps = adapter?.capabilities();
  const notes = adapter?.capabilityNotes() ?? {};
  return {
    ...t,
    configuration: parse(t.configuration),
    delivery: parse(t.delivery),
    provider: adapter ? { id: adapter.id, name: adapter.name, kind: adapter.kind } : { id: t.platform, name: t.platform, kind: "unknown" },
    agent: agent ? { id: agent.id, key: agent.key, name: agent.name, kind: agent.kind } : null,
    last_run: t.last_run ?? null,
    current_run: current,
    result: t.last_run?.summary ?? null,
    error: t.last_run?.error ?? null,
    recent_statuses: recent[t.id] ?? [],
    can: {
      run: can.ok,
      run_reason: can.ok ? null : can.reason ?? null,
      pause_at_provider: !!caps?.cancelTask,
      edit_at_provider: !!caps?.updateTask,
      unsupported: { pause_at_provider: caps?.cancelTask ? null : notes.cancelTask ?? null, edit_at_provider: caps?.updateTask ? null : notes.updateTask ?? null },
    },
  };
}
export type TaskView = Awaited<ReturnType<typeof taskView>>;

export async function listTaskViews(opts: { platform?: string; agent_id?: number; includeDisabled?: boolean } = {}): Promise<TaskView[]> {
  const recent = await recentStatusesByTask(6);
  return Promise.all((await listTasks(opts)).map((t) => taskView(t, recent)));
}

export class TaskStartError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "TaskStartError";
  }
}

/**
 * Start a task now. Creates the run, asks policy, hands it to the provider adapter, and either
 * closes the run (the provider took it and runs it elsewhere) or leaves it open for the agent's
 * callback. Throws TaskStartError when the task cannot be started at all.
 */
export async function startTask(taskId: number, opts: { text?: string; trigger?: RunTrigger; messageId?: number; idempotencyKey?: string } = {}): Promise<Run> {
  const task = await getTask(taskId);
  if (!task) throw new TaskStartError("unknown task", 404);
  const adapter: ProviderAdapter | undefined = getProvider(task.platform);
  if (!adapter) throw new TaskStartError(`unknown provider ${task.platform}`, 404);
  if (!adapter.supports("runTask")) throw adapter.unsupported("runTask");
  const ref = taskRef(task);
  const can = adapter.canRunTask(ref);
  if (!can.ok) throw new TaskStartError(can.reason ?? "this task cannot be started", 409);

  // The same key returns the same run: a retried request cannot start the task twice.
  if (opts.idempotencyKey) {
    const existing = await findRunByIdempotencyKey(opts.idempotencyKey);
    if (existing) return existing;
  }
  const agent = task.agent_id ? await getAgentProfile(task.agent_id) : await ensureTaskAgent(task);
  // The run is born queued, carrying its inputs: any worker (or this process, inline) executes it.
  const { run } = await beginRun({
    kind: "task",
    label: task.name,
    provider: task.platform,
    task_id: task.id,
    agent_id: agent?.id ?? null,
    message_id: opts.messageId ?? null,
    trigger: opts.trigger ?? "user",
    idempotency_key: opts.idempotencyKey ?? null,
    status: "queued",
    checkpoint: JSON.stringify({ v: 1, kind: "task", step: "start", inputs: { text: opts.text ?? null, trigger: opts.trigger ?? "user", message_id: opts.messageId ?? null } }),
  });
  await queue.send<TaskStartJob>(JOB.taskStart, { runId: run.id }, { singletonKey: `task-run:${run.id}` });
  return (await getRun(run.id))!;
}

/** The queued half: claim the run, pass the gate, start it. Any executing process runs this. */
export async function executeTaskRun(runId: number): Promise<void> {
  // Quotas are checked BEFORE the claim, while the run is still queued: over the concurrency
  // cap the job throws and retries on its backoff (the queue is the waiting room); over the
  // daily cap the run fails now with a message that says why — a retry cannot help today.
  try {
    await enforceRunQuotas({ selfCounted: true });
  } catch (err) {
    if (err instanceof QuotaExceededError && !err.retryable) {
      const run = await getRun(runId);
      if (run && (run.status === "queued" || run.status === "retrying")) await finishParked(run, "failed", { error: err.message });
      return;
    }
    throw err;
  }
  const claimed = await transitionRun(runId, ["queued", "retrying"], "running", { started_at: new Date().toISOString() });
  if (!claimed) return; // someone else has it, or it was cancelled while queued
  const inputs = checkpointInputs(claimed);
  const task = claimed.task_id ? await getTask(claimed.task_id) : undefined;
  const adapter = task ? getProvider(task.platform) : undefined;
  const track = new RunTracker(claimed.id, claimed.message_id);
  await withRunLease(claimed.id, () => withLogContext({ run_id: claimed.id }, async () => {
    if (!task || !adapter) {
      await endRun(claimed.id, { status: "failed", error: "the task behind this run is gone" });
      return;
    }
    if (await isCancelled(claimed.id)) {
      await endRun(claimed.id, { status: "cancelled", error: "stopped before it started" });
      return;
    }
    const agent = task.agent_id ? await getAgentProfile(task.agent_id) : undefined;
    await track.set("select", `${task.name} on ${adapter.name}`, "done", agent ? `agent: ${agent.name}` : null);
    try {
      await guard(
        { runId: claimed.id, messageId: inputs.message_id ?? null, provider: task.platform, track, kind: "task", checkpoint: { step: "start", inputs } },
        "run_task",
        `Start "${task.name}" at ${adapter.name}?`,
        inputs.text?.slice(0, 240) ?? null,
      );
    } catch (err) {
      if (err instanceof ApprovalPending) return; // parked; the decision resumes or settles it
      throw err;
    }
    await performTaskStart(claimed.id, track, task.id, { text: inputs.text ?? undefined, trigger: inputs.trigger, messageId: inputs.message_id ?? undefined });
  }));
}

/**
 * A queued run whose start job was lost (the send raced a crash, or the job expired unclaimed
 * with no retries) would wait forever: the silence reaper only watches "running". Re-send the
 * job — the guarded queued/retrying -> running claim makes redelivery harmless. After a few
 * lost attempts, stop retrying and say so.
 */
export async function requeueStuckTaskRuns(olderThanMs = 10 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  let handled = 0;
  for (const run of await systemScope(() => listStuckQueuedRunsAll(cutoff))) {
    if (run.kind !== "task") continue; // only task runs are born queued today
    handled += await withOrg(run.org_id, async () => {
      if ((run.attempt ?? 0) >= 5) {
        await finishParked(run, "failed", { error: "Its start job kept getting lost. Start it again by hand." });
        return 1;
      }
      const bumped = await transitionRun(run.id, [run.status], "queued", { attempt: (run.attempt ?? 0) + 1, queued_at: new Date().toISOString() });
      if (!bumped) return 0; // someone claimed it meanwhile — alive after all
      await queue.send<TaskStartJob>(JOB.taskStart, { runId: run.id }, { singletonKey: `task-run:${run.id}:r${bumped.attempt}` });
      return 1;
    });
  }
  return handled;
}

function checkpointInputs(run: Run): { text?: string | null; trigger?: RunTrigger; message_id?: number | null } {
  try {
    return run.checkpoint ? ((JSON.parse(run.checkpoint) as { inputs?: Record<string, unknown> }).inputs as { text?: string | null; trigger?: RunTrigger; message_id?: number | null }) ?? {} : {};
  } catch {
    return {};
  }
}

/** The start segment: everything after the gate. Runs first-pass and on resume after approval. */
async function performTaskStart(runId: number, track: RunTracker, taskId: number, opts: { text?: string; trigger?: RunTrigger; messageId?: number }): Promise<Run> {
  const task = (await getTask(taskId))!;
  const adapter = getProvider(task.platform)!;
  const agent = task.agent_id ? await getAgentProfile(task.agent_id) : undefined;
  await track.start("start", `Starting at ${adapter.name}`);
  const reportUrl = config.publicUrl ? `${config.publicUrl}/api/runs/${runId}` : null;
  const r = await adapter.runTask(taskRef(task), { runId, track, messageId: opts.messageId, trigger: opts.trigger }, { text: opts.text, run_id: runId, report_url: reportUrl });
  if (!r.ok) {
    await track.fail("start", r.message);
    log.warn(`task ${task.id} (${task.name}) could not be started: ${r.message}`);
    return (await endRun(runId, { status: "failed", error: r.message }))!;
  }
  await track.done("start", r.message);
  if (r.pending) {
    await track.waiting("report", `Waiting for ${agent?.name ?? task.name} to report back`);
    return (await getRun(runId))!;
  }
  return (await endRun(runId, { status: "success", summary: r.message, output_url: r.url ?? null, external_id: r.external_id ?? null }))!;
}

registerResumer("task", async (run) => {
  if (!run.task_id) {
    await endRun(run.id, { status: "failed", error: "the task behind this run is gone" });
    return;
  }
  const inputs = checkpointInputs(run);
  await withRunLease(run.id, () =>
    withLogContext({ run_id: run.id }, () =>
      performTaskStart(run.id, new RunTracker(run.id, run.message_id), run.task_id!, { text: inputs.text ?? undefined, trigger: inputs.trigger, messageId: inputs.message_id ?? undefined }),
    ),
  );
});
