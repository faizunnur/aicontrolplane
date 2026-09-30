import type { Page, Response } from "playwright";
import { browser } from "../../browser/manager.js";
import { cleanError, isStall, PageController } from "../../browser/page.js";
import { config } from "../../config.js";
import { host } from "../../browser/host.js";
import { logger } from "../../logger.js";
import { compilePatterns } from "./patterns.js";
import type { PlatformConfig, SessionStatus } from "../../../packages/core/src/index.js";
import type { ExecutionContext, TaskListResult } from "../types.js";
import { detectChallenge, detectLoginState } from "./login.js";
import { normalizePayloads } from "./normalize.js";

const log = logger("browser-tasks");

/*
  "What tasks does this provider have?" through the browser: visit the provider's tasks page in
  its tab, capture the JSON its web app fetches, screenshot the page, detect the login state and
  normalise what was seen into tasks and runs. Turning that into registry rows, events and alerts
  is the control plane's job (src/sync.ts).
*/

interface Captured {
  url: string;
  method: string;
  status: number;
  contentType: string;
  body: string;
}

export interface Discovered {
  url: string;
  status: number;
  size: number;
  matched: boolean;
}

export interface CollectMeta extends Record<string, unknown> {
  finalUrl: string;
  title: string;
  captures: number;
  discovered: Discovered[];
  snapshot: string;
  screenshotPath: string | null;
}

export type OutputUrlHook = (raw: Record<string, unknown>) => string | null;

export async function collectTasks(p: PlatformConfig, outputUrlFor: OutputUrlHook, ctx: ExecutionContext): Promise<TaskListResult> {
  return browser.withLock(
    async () => {
      try {
        return await collectOnce(p, outputUrlFor, ctx);
      } catch (err) {
        // A stall during the capture itself (after navigation) gets one fresh tab.
        if (!isStall(err)) throw err;
        log.warn(`collect ${p.id}: ${cleanError(err)}; retrying on a fresh tab`);
        await browser.resetConsolePage(p.id);
        return await collectOnce(p, outputUrlFor, ctx);
      }
    },
    { label: `Looking at ${p.name}'s tasks`, platform: p.id, messageId: ctx.messageId ?? null },
  );
}

async function collectOnce(p: PlatformConfig, outputUrlFor: OutputUrlHook, ctx: ExecutionContext): Promise<TaskListResult> {
  const pc = new PageController(p.id, p.name);
  const patterns = compilePatterns(p.capturePatterns);
  const captured: Captured[] = [];
  const discovered = new Map<string, Discovered>();

  const onResponse = async (resp: Response) => {
    try {
      const req = resp.request();
      const rt = req.resourceType();
      if (rt !== "xhr" && rt !== "fetch") return;
      const ct = resp.headers()["content-type"] ?? "";
      if (!/json/i.test(ct)) return;
      const url = resp.url();
      const matched = patterns.length > 0 && patterns.some((r) => r.test(url));
      let body = "";
      if (matched) {
        body = await resp.text().catch(() => "");
        captured.push({ url, method: req.method(), status: resp.status(), contentType: ct, body });
      }
      const key = url.split("?")[0];
      const prev = discovered.get(key);
      discovered.set(key, { url: key, status: resp.status(), size: Math.max(prev?.size ?? 0, body.length), matched });
    } catch {
      /* ignore individual response failures */
    }
  };

  await ctx.track?.start("open", `Opening ${p.name}'s tasks page`);
  const listening: Page[] = [];
  let page: Page;
  try {
    page = await pc.open(p.tasksUrl, {
      networkIdleMs: 20_000,
      settleMs: config.sync.settleMs,
      beforeNavigate: (pg) => {
        pg.on("response", onResponse);
        listening.push(pg);
      },
    });
  } finally {
    for (const pg of listening) pg.off("response", onResponse);
  }
  const finalUrl = page.url();
  await ctx.track?.done("open", hostOf(finalUrl));

  await ctx.track?.start("check", "Checking the sign-in");
  // A bot-check wall first: the session cookie survives behind it, so the login check alone
  // would call it signed in and the sync would report an empty, "successful" task list.
  const { challenge } = await detectChallenge(page);
  if (challenge) {
    await ctx.track?.fail("check", "human-verification challenge");
    const screenshotPath = await pc.screenshot(page);
    const message = `${p.name} is showing a human-verification challenge — open the live view or re-run sign-in.`;
    log.warn(`collect ${p.id}: ${challenge} challenge (${finalUrl})`);
    return { ok: false, sessionStatus: "needs_login", tasks: [], runs: [], meta: { finalUrl, title: await page.title().catch(() => ""), captures: 0, discovered: [], snapshot: "", screenshotPath }, message };
  }
  const sessionStatus: SessionStatus = await detectLoginState(p, page, { unauthorized: captured.some((c) => c.status === 401) });
  if (sessionStatus === "needs_login") await ctx.track?.fail("check", "signed out");
  else await ctx.track?.done("check", "signed in");

  await ctx.track?.start("capture", "Reading what the page loaded");
  const screenshotPath = await pc.screenshot(page);
  const snapshot = await textSnapshot(p, page);
  for (const c of captured) await host().addCapture({ platform: p.id, url: c.url, method: c.method, status: c.status, content_type: c.contentType, body: c.body });
  await host().pruneCaptures(p.id);

  const norm = sessionStatus === "logged_in" ? normalizePayloads(p, captured.map((c) => tryParse(c.body)).filter((v) => v !== undefined), { outputUrlFor }) : { tasks: [], runs: [] };
  await ctx.track?.done("capture", `${captured.length} payloads, ${norm.tasks.length} tasks, ${norm.runs.length} runs`);

  const meta: CollectMeta = {
    finalUrl,
    title: await page.title().catch(() => ""),
    captures: captured.length,
    discovered: [...discovered.values()].sort((a, b) => Number(b.matched) - Number(a.matched) || b.size - a.size).slice(0, 80),
    snapshot,
    screenshotPath,
  };
  const message = sessionStatus === "needs_login" ? "login required" : `captured ${captured.length} payloads, ${norm.tasks.length} tasks, ${norm.runs.length} runs`;
  log.info(`collect ${p.id}: ${message} (${finalUrl})`);
  return { ok: true, sessionStatus, tasks: norm.tasks, runs: norm.runs, meta, message };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function textSnapshot(p: PlatformConfig, page: Page): Promise<string> {
  const selectors = [p.snapshotSelector || "main", "body"];
  for (const sel of selectors) {
    try {
      const text = await page.locator(sel).first().innerText({ timeout: 5_000 });
      if (text && text.trim()) return text.replace(/\n{3,}/g, "\n\n").slice(0, 20_000);
    } catch {
      /* try next */
    }
  }
  return "";
}

function tryParse(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
