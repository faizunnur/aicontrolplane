import { ensureSystemAgent } from "./agents.js";
import { config } from "./config.js";
import { getTask } from "./db.js";
import { getPlatform } from "./platforms.js";
import { ApprovalPending, guard, registerResumer } from "./policy.js";
import { screenshotProvider } from "./providers/browser/actions.js";
import { getProvider } from "./providers/registry.js";
import type { ActionResult, ExecutionContext } from "./providers/types.js";
import { beginRun, endRun, RunTracker } from "./runs.js";
import { syncProvider } from "./sync.js";
import type { PlatformConfig, Task } from "../packages/core/src/index.js";

export type { ActionResult } from "./providers/types.js";

/*
  Actions the control plane can run against a provider: three built-ins (open, screenshot,
  sync) plus whatever browser actions the provider's configuration defines. The provider
  adapter performs them; this module decides whether they may run (approval), gives each one
  a run so it shows up in the timeline, and passes the variables.
*/

export const BUILTIN_ACTIONS: Record<string, { label: string; description: string }> = {
  open: { label: "Open in browser", description: "Navigate the provider's tab to the task (or tasks page) so it is ready in the live view." },
  screenshot: { label: "Screenshot", description: "Refresh the screenshot of the provider's tab without navigating." },
  sync: { label: "Sync now", description: "Visit the tasks page, capture data, refresh screenshot and session state." },
};

/** Actions available for a provider: built-ins plus whatever is configured in platforms.json. */
export function availableActions(p: PlatformConfig) {
  const out: { id: string; label: string; description: string; builtin: boolean }[] = [];
  for (const [id, meta] of Object.entries(BUILTIN_ACTIONS)) {
    if (id === "sync" && !p.tasksUrl) continue;
    if (id === "open" && !p.tasksUrl && !p.appUrl) continue;
    out.push({ id, ...meta, builtin: true });
  }
  for (const [id, def] of Object.entries(p.actions ?? {})) {
    if (id === "send_message") continue; // used by message delivery, needs a {{message}} variable
    out.push({ id, label: def.label ?? id, description: def.description ?? `${def.steps?.length ?? 0} step(s)`, builtin: false });
  }
  return out;
}

export async function runAction(p: PlatformConfig, action: string, task?: Task, extraVars: Record<string, string> = {}, ctx: ExecutionContext = {}): Promise<ActionResult> {
  if (!config.browser.enabled) return { ok: false, action, message: "browser is disabled" };
  const adapter = getProvider(p.id);
  if (!adapter) return { ok: false, action, message: `unknown provider ${p.id}` };
  // A sync is its own kind of run and makes one for itself.
  if (action === "sync") {
    if (!adapter.supports("listTasks")) return { ok: false, action, message: adapter.unsupported("listTasks").reason };
    const r = await syncProvider(adapter, ctx);
    return { ok: r.ok, action, message: r.message ?? (r.ok ? "synced" : "sync failed"), url: r.finalUrl, screenshot: true };
  }

  // Every other action is a run of its own unless the caller already has one (a dispatch).
  const label = p.actions?.[action]?.label ?? BUILTIN_ACTIONS[action]?.label ?? action;
  const own = !ctx.runId;
  const scope = own ? await beginRun({ kind: "action", label: `${label} on ${p.name}`, provider: p.id, task_id: task?.id ?? null, trigger: ctx.trigger ?? "user", agent_id: (await ensureSystemAgent()).id }) : null;
  const c: ExecutionContext = own ? { ...ctx, runId: scope!.run.id, track: scope!.track } : ctx;
  let result: ActionResult;
  try {
    result = await perform(adapter.config(), adapter, action, task, extraVars, c);
  } catch (err) {
    if (err instanceof ApprovalPending && own) {
      // The run is parked on its approval; the decision resumes or settles it.
      return { ok: true, action, message: "Waiting for your approval.", pending: true };
    }
    throw err; // a caller-owned run: whoever began it decides what parking means
  }
  if (scope) await endRun(scope.run.id, { status: result.ok ? "success" : "failed", summary: result.message, error: result.ok ? null : result.message, output_url: result.url ?? null });
  return result;
}

registerResumer("action", async (run) => {
  const checkpoint = (() => {
    try {
      return run.checkpoint ? (JSON.parse(run.checkpoint) as { inputs?: { action?: string; vars?: Record<string, string>; task_id?: number | null; platform?: string } }) : null;
    } catch {
      return null;
    }
  })();
  const inputs = checkpoint?.inputs;
  const p = inputs?.platform ? getPlatform(inputs.platform) : run.provider ? getPlatform(run.provider) : undefined;
  const adapter = p ? getProvider(p.id) : undefined;
  if (!p || !adapter || !inputs?.action) {
    await endRun(run.id, { status: "failed", error: "the action behind this run cannot be reconstructed" });
    return;
  }
  const task = inputs.task_id ? await getTask(inputs.task_id) : undefined;
  const track = new RunTracker(run.id, run.message_id);
  const result = await perform(adapter.config(), adapter, inputs.action, task ?? undefined, inputs.vars ?? {}, { runId: run.id, track, approved: true });
  await endRun(run.id, { status: result.ok ? "success" : "failed", summary: result.message, error: result.ok ? null : result.message, output_url: result.url ?? null });
});

async function perform(p: PlatformConfig, adapter: NonNullable<ReturnType<typeof getProvider>>, action: string, task: Task | undefined, extraVars: Record<string, string>, ctx: ExecutionContext): Promise<ActionResult> {
  if (action === "open") {
    const url = task?.native_url || p.tasksUrl || p.appUrl;
    if (!url) return { ok: false, action, message: "no URL to open" };
    await ctx.track?.start("open", `Opening ${url}`);
    const r = await adapter.openConsole(url, ctx);
    if (r.ok) await ctx.track?.done("open");
    else await ctx.track?.fail("open", r.message);
    return { ...r, action };
  }
  if (action === "screenshot") {
    await ctx.track?.start("screenshot", `Taking a screenshot of ${p.name}`);
    const file = await screenshotProvider(p);
    if (file) await ctx.track?.done("screenshot");
    else await ctx.track?.fail("screenshot", "screenshot failed");
    return { ok: !!file, action, message: file ? "screenshot refreshed" : "screenshot failed", screenshot: !!file };
  }

  const def = p.actions?.[action];
  if (!def) return { ok: false, action, message: `unknown action "${action}"` };
  if (!adapter.supports("runAction")) return { ok: false, action, message: adapter.unsupported("runAction").reason };

  const vars: Record<string, string> = {
    native_url: task?.native_url ?? p.tasksUrl ?? p.appUrl ?? "",
    key: task?.key ?? "",
    name: task?.name ?? "",
    tasksUrl: p.tasksUrl ?? "",
    appUrl: p.appUrl ?? "",
    ...extraVars,
  };

  // A configured action changes something on the site: policy decides whether it waits for
  // you. On "ask" the run parks (ApprovalPending propagates to whoever began it); a resume
  // after approval passes ctx.approved and skips the gate.
  if (!ctx.approved && ctx.runId) {
    await guard(
      { runId: ctx.runId, messageId: ctx.messageId, provider: p.id, track: ctx.track, kind: ctx.runKind ?? "action", checkpoint: { step: "run", inputs: { action, vars: extraVars, task_id: task?.id ?? null, platform: p.id } } },
      "run_action",
      `Run "${def.label ?? action}" on ${p.name}?`,
      extraVars.message?.slice(0, 240) ?? null,
    );
  }
  return adapter.runAction(action, vars, ctx);
}
