import type { Page } from "playwright";
import { browser } from "../../browser/manager.js";
import { cleanError, PageController } from "../../browser/page.js";
import { logger } from "../../logger.js";
import type { ActionStep, PlatformConfig } from "../../types.js";
import type { ActionResult, ExecutionContext } from "../types.js";

const log = logger("browser-actions");

/**
 * Run one of a provider's configured browser actions: a list of goto / click / fill / press /
 * wait steps written against that provider's site. Provider-specific by construction; the
 * control plane decides whether it may run (approval) before calling this.
 */
export async function runConfiguredAction(cfg: PlatformConfig, action: string, vars: Record<string, string>, ctx: ExecutionContext): Promise<ActionResult> {
  const def = cfg.actions?.[action];
  if (!def) return { ok: false, action, message: `unknown action "${action}"` };
  const sub = (s?: string) => (s ?? "").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
  return browser.withLock(
    async () => {
      const pc = new PageController(cfg.id, cfg.name);
      const page = await pc.current();
      let stepNo = 0;
      try {
        for (const step of def.steps ?? []) {
          stepNo++;
          ctx.track?.start(`step-${stepNo}`, describeStep(step, sub));
          await runStep(page, step, sub);
          ctx.track?.done(`step-${stepNo}`);
        }
        await pc.screenshot(page);
        return { ok: true, action, message: `ran ${stepNo} step(s)`, url: page.url(), screenshot: true };
      } catch (err) {
        const msg = cleanError(err);
        log.warn(`action ${cfg.id}/${action} failed at step ${stepNo}: ${msg}`);
        ctx.track?.fail(`step-${stepNo}`, msg);
        await pc.screenshot(page);
        return { ok: false, action, message: `step ${stepNo} failed: ${msg}`, url: page.url(), screenshot: true };
      }
    },
    { label: `Running "${def.label ?? action}" on ${cfg.name}`, platform: cfg.id, messageId: ctx.messageId ?? null },
  );
}

/** Screenshot a provider's tab on demand, opening its home page first if the tab is still blank. */
export async function screenshotProvider(cfg: PlatformConfig): Promise<string | null> {
  return browser.withLock(() => new PageController(cfg.id, cfg.name).screenshotOrOpen(cfg.tasksUrl || cfg.appUrl), { label: `Taking a screenshot of ${cfg.name}`, platform: cfg.id });
}

export function describeStep(step: ActionStep, sub: (s?: string) => string): string {
  switch (step.type) {
    case "goto":
      return `Opening ${sub(step.url)}`;
    case "click":
      return `Clicking ${step.selector}`;
    case "fill":
      return `Filling in ${step.selector}`;
    case "press":
      return `Pressing ${step.key ?? "Enter"}`;
    case "wait":
      return `Waiting ${Math.round((step.ms ?? 1000) / 1000)}s`;
    case "waitFor":
      return `Waiting for ${step.selector}`;
    default:
      return step.type;
  }
}

async function runStep(page: Page, step: ActionStep, sub: (s?: string) => string) {
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
