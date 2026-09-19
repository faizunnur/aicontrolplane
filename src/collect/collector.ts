import fs from "node:fs";
import path from "node:path";
import type { Page, Response } from "playwright";
import { browser } from "../browser/manager.js";
import { config } from "../config.js";
import {
  addCapture,
  addEvent,
  findAgent,
  finishSyncLog,
  getPlatformState,
  pruneCaptures,
  recordRun,
  setPlatformState,
  startSyncLog,
  upsertAgent,
} from "../db.js";
import { logger } from "../logger.js";
import { compilePatterns } from "../platforms.js";
import { sendAlert } from "../alerts.js";
import type { PlatformConfig, SessionStatus } from "../types.js";
import { normalizePayloads } from "./normalize.js";

const log = logger("collector");

export interface SyncResult {
  platform: string;
  ok: boolean;
  sessionStatus: SessionStatus;
  finalUrl?: string;
  agents: number;
  runs: number;
  captures: number;
  discovered: number;
  message?: string;
}

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

/**
 * Visit the platform's tasks page in the console tab, capture the JSON the app
 * fetches, screenshot the page, detect the login state and normalise what we saw.
 */
export async function syncPlatform(p: PlatformConfig): Promise<SyncResult> {
  const logId = startSyncLog(p.id);
  const before = getPlatformState(p.id);
  let result: SyncResult;
  try {
    result = await browser.withLock(() => collect(p));
  } catch (err) {
    const message = cleanError(err);
    log.error(`sync ${p.id} failed: ${message}`);
    result = { platform: p.id, ok: false, sessionStatus: "error", agents: 0, runs: 0, captures: 0, discovered: 0, message };
  }

  const ts = new Date().toISOString();
  setPlatformState(p.id, {
    session_status: result.sessionStatus,
    last_sync_at: ts,
    last_ok_at: result.ok ? ts : before.last_ok_at,
    last_error: result.ok ? null : (result.message ?? "sync failed"),
  });
  finishSyncLog(logId, { ok: result.ok, message: result.message, agents: result.agents, runs: result.runs, captures: result.captures });

  if (result.sessionStatus === "needs_login" && before.session_status !== "needs_login") {
    addEvent({
      platform: p.id,
      kind: "session",
      title: `${p.name}: login required`,
      body: `The browser session for ${p.name} is no longer authenticated. Open the browser screen and sign in again.`,
      link: "/vnc/",
      dedupe_key: `session:${p.id}:${ts.slice(0, 10)}`,
    });
    void sendAlert({ key: `session:${p.id}`, title: `${p.name} needs login`, body: "Open the control plane browser screen and sign in." });
  }
  if (!result.ok && result.sessionStatus === "error" && before.session_status !== "error") {
    addEvent({
      platform: p.id,
      kind: "sync_error",
      title: `${p.name}: sync error`,
      body: result.message ?? null,
      dedupe_key: `sync_error:${p.id}:${ts.slice(0, 13)}`,
    });
    void sendAlert({ key: `sync_error:${p.id}`, title: `${p.name} sync error`, body: result.message });
  }
  return result;
}

async function collect(p: PlatformConfig): Promise<SyncResult> {
  try {
    return await collectOnce(p);
  } catch (err) {
    // A cold or wedged tab occasionally stalls its first navigation. Retry once on a fresh tab.
    const msg = cleanError(err);
    if (!/Timeout|Target closed|has been closed|crashed/i.test(msg)) throw err;
    log.warn(`sync ${p.id}: ${msg}; retrying on a fresh tab`);
    await browser.resetConsolePage(p.id);
    return collectOnce(p);
  }
}

async function collectOnce(p: PlatformConfig): Promise<SyncResult> {
  const page = await browser.consolePage(p.id);
  const patterns = compilePatterns(p.capturePatterns);
  const loginPatterns = compilePatterns(p.loginUrlPatterns);
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

  page.on("response", onResponse);
  try {
    await page.bringToFront().catch(() => undefined);
    await page.goto(p.tasksUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(config.sync.settleMs);
  } finally {
    page.off("response", onResponse);
  }

  const finalUrl = page.url();
  const sessionStatus = await detectSession(p, page, finalUrl, captured, loginPatterns);
  const screenshotPath = await screenshot(p.id, page);
  const snapshot = await textSnapshot(p, page);

  for (const c of captured) {
    addCapture({ platform: p.id, url: c.url, method: c.method, status: c.status, content_type: c.contentType, body: c.body });
  }
  pruneCaptures(p.id);

  let agents = 0;
  let runs = 0;
  if (sessionStatus === "logged_in") {
    const payloads = captured.map((c) => tryParse(c.body)).filter((v) => v !== undefined);
    const norm = normalizePayloads(p, payloads);
    for (const t of norm.tasks) {
      upsertAgent({
        platform: p.id,
        key: t.key,
        name: t.name,
        source: "discovered",
        schedule: t.schedule,
        status: t.status,
        native_url: t.native_url,
        purpose: t.purpose,
        meta: { raw: t.raw, discovered_at: new Date().toISOString() },
      });
      agents++;
    }
    for (const r of norm.runs) {
      const agent = findAgent(p.id, r.taskKey);
      if (!agent) continue;
      const { created } = recordRun({
        agent_id: agent.id,
        external_id: r.external_id,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        summary: r.summary,
        output_url: r.output_url,
        source: "collector",
        raw: r.raw,
      });
      runs++;
      if (created && (r.status === "failed" || r.status === "needs_attention")) {
        addEvent({
          platform: p.id,
          kind: "run",
          title: `${agent.name}: ${r.status.replace("_", " ")}`,
          body: r.summary,
          link: r.output_url ?? agent.native_url,
          dedupe_key: `run:${agent.id}:${r.external_id}`,
        });
        void sendAlert({ key: `run:${agent.id}`, title: `${p.name} · ${agent.name} ${r.status}`, body: r.summary ?? undefined, link: r.output_url ?? undefined });
      }
    }
  }

  setPlatformState(p.id, {
    screenshot_path: screenshotPath,
    meta: JSON.stringify({
      finalUrl,
      title: await page.title().catch(() => ""),
      discovered: [...discovered.values()].sort((a, b) => Number(b.matched) - Number(a.matched) || b.size - a.size).slice(0, 80),
      snapshot,
      snapshotAt: new Date().toISOString(),
    }),
  });

  const message =
    sessionStatus === "needs_login"
      ? "login required"
      : `captured ${captured.length} payloads, ${agents} tasks, ${runs} runs`;
  log.info(`sync ${p.id}: ${message} (${finalUrl})`);
  return { platform: p.id, ok: true, sessionStatus, finalUrl, agents, runs, captures: captured.length, discovered: discovered.size, message };
}

async function detectSession(p: PlatformConfig, page: Page, finalUrl: string, captured: Captured[], loginPatterns: RegExp[]): Promise<SessionStatus> {
  if (loginPatterns.some((r) => r.test(finalUrl))) return "needs_login";
  if (captured.some((c) => c.status === 401)) return "needs_login";
  if (p.sessionCookie) {
    const cookies = await browser.cookies(p.cookieDomain || undefined);
    if (!cookies.some((c) => c.name === p.sessionCookie)) return "needs_login";
  }
  if (p.loggedInSelector) {
    const n = await page.locator(p.loggedInSelector).count().catch(() => 0);
    if (n === 0) return "needs_login";
  }
  return "logged_in";
}

async function screenshot(platformId: string, page: Page): Promise<string | null> {
  try {
    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const file = path.join(config.screenshotDir, `${platformId}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 15_000 });
    return file;
  } catch (err) {
    log.warn(`screenshot failed for ${platformId}`, err);
    return null;
  }
}

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

/** Playwright errors carry ANSI colour codes and multi-line call logs; keep the readable first line. */
export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw.replace(/\u001b\[[0-9;]*m/g, "");
  const first = stripped.split("\n").find((l) => l.trim()) ?? stripped;
  return first.trim().slice(0, 500);
}

function tryParse(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Screenshot the console tab without navigating (used by the dashboard's Screenshot button). */
export async function snapshotOnly(p: PlatformConfig): Promise<string | null> {
  return browser.withLock(() => screenshotConsoleTab(p));
}

/**
 * Same as snapshotOnly but without taking the browser lock. Only call this from
 * code that already holds the lock (the lock is not re-entrant).
 */
export async function screenshotConsoleTab(p: PlatformConfig): Promise<string | null> {
  const page = await browser.consolePage(p.id);
  if (page.url() === "about:blank" && (p.tasksUrl || p.appUrl)) {
    await page.goto(p.tasksUrl || p.appUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  }
  const file = await screenshot(p.id, page);
  if (file) setPlatformState(p.id, { screenshot_path: file });
  return file;
}
