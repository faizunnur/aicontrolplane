import { browser } from "./browser/manager.js";
import { cleanError, screenshotConsoleTab, snapshotOnly, syncPlatform } from "./collect/collector.js";
import { logger } from "./logger.js";
import type { ActionStep, Agent, PlatformConfig } from "./types.js";

const log = logger("actions");

export interface ActionResult {
  ok: boolean;
  action: string;
  message: string;
  url?: string;
  screenshot?: boolean;
}

export const BUILTIN_ACTIONS: Record<string, { label: string; description: string }> = {
  open: { label: "Open in browser", description: "Navigate the platform's console tab to the task (or tasks page) so it is ready on the VNC screen." },
  screenshot: { label: "Screenshot", description: "Refresh the screenshot of the console tab without navigating." },
  sync: { label: "Sync now", description: "Visit the tasks page, capture data, refresh screenshot and session state." },
};

/** Actions available for a platform: built-ins plus whatever is configured in platforms.json. */
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

export async function runAction(p: PlatformConfig, action: string, agent?: Agent, extraVars: Record<string, string> = {}): Promise<ActionResult> {
  if (!browser.enabled) return { ok: false, action, message: "browser is disabled" };

  if (action === "open") {
    const url = agent?.native_url || p.tasksUrl || p.appUrl;
    if (!url) return { ok: false, action, message: "no URL to open" };
    await browser.withLock(() => browser.consolePage(p.id, url));
    return { ok: true, action, message: `console tab is on ${url}. Open the browser screen to interact.`, url };
  }
  if (action === "screenshot") {
    const file = await snapshotOnly(p);
    return { ok: !!file, action, message: file ? "screenshot refreshed" : "screenshot failed", screenshot: !!file };
  }
  if (action === "sync") {
    const r = await syncPlatform(p);
    return { ok: r.ok, action, message: r.message ?? (r.ok ? "synced" : "sync failed"), url: r.finalUrl, screenshot: true };
  }

  const def = p.actions?.[action];
  if (!def) return { ok: false, action, message: `unknown action "${action}"` };

  const vars: Record<string, string> = {
    native_url: agent?.native_url ?? p.tasksUrl ?? p.appUrl ?? "",
    key: agent?.key ?? "",
    name: agent?.name ?? "",
    tasksUrl: p.tasksUrl ?? "",
    appUrl: p.appUrl ?? "",
    ...extraVars,
  };
  const sub = (s?: string) => (s ?? "").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

  return browser.withLock(async () => {
    const page = await browser.consolePage(p.id);
    let stepNo = 0;
    try {
      for (const step of def.steps ?? []) {
        stepNo++;
        await runStep(page, step, sub);
      }
      // We already hold the browser lock here, so use the unlocked screenshot helper.
      await screenshotConsoleTab(p).catch(() => null);
      return { ok: true, action, message: `ran ${stepNo} step(s)`, url: page.url(), screenshot: true };
    } catch (err) {
      const msg = cleanError(err);
      log.warn(`action ${p.id}/${action} failed at step ${stepNo}: ${msg}`);
      await screenshotConsoleTab(p).catch(() => null);
      return { ok: false, action, message: `step ${stepNo} failed: ${msg}`, url: page.url(), screenshot: true };
    }
  });
}

async function runStep(page: import("playwright").Page, step: ActionStep, sub: (s?: string) => string) {
  const timeout = 20_000;
  switch (step.type) {
    case "goto":
      await page.goto(sub(step.url), { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    case "click":
      await page.locator(sub(step.selector)).first().click({ timeout });
      return;
    case "fill":
      await page.locator(sub(step.selector)).first().fill(sub(step.value), { timeout });
      return;
    case "press":
      if (step.selector) await page.locator(sub(step.selector)).first().press(step.key ?? "Enter", { timeout });
      else await page.keyboard.press(step.key ?? "Enter");
      return;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms ?? 1000, 30_000));
      return;
    case "waitFor":
      await page.locator(sub(step.selector)).first().waitFor({ timeout, state: "visible" });
      return;
    default:
      throw new Error(`unsupported step type ${(step as ActionStep).type}`);
  }
}
