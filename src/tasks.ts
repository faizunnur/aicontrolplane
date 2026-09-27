import { ensureTaskAgent } from "./agents.js";
import { config } from "./config.js";
import { withLogContext } from "./context.js";
import { findRunByIdempotencyKey, getAgentProfile, getRun, getTask, listRuns, listTasks, recentStatusesByTask, type TaskWithLastRun } from "./db.js";
import { logger } from "./logger.js";
import { ApprovalPending, guard, registerResumer } from "./policy.js";
import { getProvider } from "./providers/registry.js";
import type { ProviderAdapter, TaskRef } from "./providers/types.js";
import { beginRun, endRun, RunTracker } from "./runs.js";
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
  const { run, track } = await beginRun({ kind: "task", label: task.name, provider: task.platform, task_id: task.id, agent_id: agent?.id ?? null, message_id: opts.messageId ?? null, trigger: opts.trigger ?? "user", idempotency_key: opts.idempotencyKey ?? null });
  // Everything this run does logs with its id attached.
  return withLogContext({ run_id: run.id }, async () => {
    await track.set("select", `${task.name} on ${adapter.name}`, "done", agent ? `agent: ${agent.name}` : null);
    try {
      await guard(
        { runId: run.id, messageId: opts.messageId ?? null, provider: task.platform, track, kind: "task", checkpoint: { step: "start", inputs: { text: opts.text ?? null, trigger: opts.trigger ?? "user", message_id: opts.messageId ?? null } } },
        "run_task",
        `Start "${task.name}" at ${adapter.name}?`,
        opts.text?.slice(0, 240) ?? null,
      );
    } catch (err) {
      // Parked: the caller gets the run in waiting_approval; the decision resumes or settles it.
      if (err instanceof ApprovalPending) return (await getRun(run.id))!;
      throw err;
    }
    return performTaskStart(run.id, track, task.id, { text: opts.text, trigger: opts.trigger, messageId: opts.messageId });
  });
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
  const checkpoint = (() => {
    try {
      return run.checkpoint ? (JSON.parse(run.checkpoint) as { inputs?: { text?: string | null; trigger?: RunTrigger; message_id?: number | null } }) : null;
    } catch {
      return null;
    }
  })();
  const inputs = checkpoint?.inputs ?? {};
  await withLogContext({ run_id: run.id }, () =>
    performTaskStart(run.id, new RunTracker(run.id, run.message_id), run.task_id!, { text: inputs.text ?? undefined, trigger: inputs.trigger, messageId: inputs.message_id ?? undefined }),
  );
});
