import { ensureSystemAgent } from "./agents.js";
import { browser } from "./browser/manager.js";
import { guard } from "./policy.js";
import { screenshotProvider } from "./providers/browser/actions.js";
import { getProvider } from "./providers/registry.js";
import type { ActionResult, ExecutionContext } from "./providers/types.js";
import { beginRun, endRun } from "./runs.js";
import { syncProvider } from "./sync.js";
import type { PlatformConfig, Task } from "./types.js";

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
  if (!browser.enabled) return { ok: false, action, message: "browser is disabled" };
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
  const scope = own ? beginRun({ kind: "action", label: `${label} on ${p.name}`, provider: p.id, task_id: task?.id ?? null, trigger: ctx.trigger ?? "user", agent_id: ensureSystemAgent().id }) : null;
  const c: ExecutionContext = own ? { ...ctx, runId: scope!.run.id, track: scope!.track } : ctx;
  const result = await perform(adapter.config(), adapter, action, task, extraVars, c);
  if (scope) endRun(scope.run.id, { status: result.ok ? "success" : "failed", summary: result.message, error: result.ok ? null : result.message, output_url: result.url ?? null });
  return result;
}

async function perform(p: PlatformConfig, adapter: NonNullable<ReturnType<typeof getProvider>>, action: string, task: Task | undefined, extraVars: Record<string, string>, ctx: ExecutionContext): Promise<ActionResult> {
  if (action === "open") {
    const url = task?.native_url || p.tasksUrl || p.appUrl;
    if (!url) return { ok: false, action, message: "no URL to open" };
    ctx.track?.start("open", `Opening ${url}`);
    await browser.withLock(() => browser.consolePage(p.id, url), { label: `Opening ${p.name}`, platform: p.id, messageId: ctx.messageId ?? null });
    ctx.track?.done("open");
    return { ok: true, action, message: `console tab is on ${url}. Watch it in the live view.`, url };
  }
  if (action === "screenshot") {
    ctx.track?.start("screenshot", `Taking a screenshot of ${p.name}`);
    const file = await screenshotProvider(p);
    if (file) ctx.track?.done("screenshot");
    else ctx.track?.fail("screenshot", "screenshot failed");
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

  // A configured action changes something on the site: policy decides whether it waits for you.
  const decision = await guard({ runId: ctx.runId, messageId: ctx.messageId, provider: p.id, track: ctx.track }, "run_action", `Run "${def.label ?? action}" on ${p.name}?`, extraVars.message?.slice(0, 240) ?? null);
  if (decision !== "approved") return { ok: false, action, message: decision === "timeout" ? "not approved within 15 minutes" : "you rejected it" };

  return adapter.runAction(action, vars, ctx);
}
