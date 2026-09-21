import fs from "node:fs";
import path from "node:path";
import { browser } from "../browser/manager.js";
import { config } from "../config.js";
import { setPlatformState } from "../db.js";
import { logger } from "../logger.js";
import type { PlatformConfig } from "../types.js";
import { cleanError, detectLoginState } from "./session.js";

const log = logger("chat");

export interface ChatResult {
  ok: boolean;
  reply?: string;
  partial?: boolean;
  url?: string;
  error?: string;
}

const REPLY_TIMEOUT_MS = 120_000;
const STABLE_POLLS = 3; // reply text unchanged for this many 1s polls => finished

/**
 * Send an instruction to a connected AI exactly the way you would: open a new
 * conversation, type it, send it, wait for the answer, and read the answer back.
 */
export async function chatWithConnection(p: PlatformConfig, text: string): Promise<ChatResult> {
  if (!browser.enabled) return { ok: false, error: "the browser is disabled on this deployment" };
  if (!p.composerSelector) return { ok: false, error: `${p.name} has no chat box configured` };
  return browser.withLock(async () => {
    try {
      return await chatOnce(p, text);
    } catch (err) {
      const msg = cleanError(err);
      if (/Timeout|Target closed|has been closed|crashed/i.test(msg)) {
        log.warn(`chat ${p.id}: ${msg}; retrying on a fresh tab`);
        await browser.resetConsolePage(p.id);
        try {
          return await chatOnce(p, text);
        } catch (err2) {
          return { ok: false, error: cleanError(err2) };
        }
      }
      return { ok: false, error: msg };
    }
  });
}

async function chatOnce(p: PlatformConfig, text: string): Promise<ChatResult> {
  const page = await browser.consolePage(p.id);
  const url = p.chatUrl || p.appUrl;
  await page.bringToFront().catch(() => undefined);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  if ((await detectLoginState(p, page)) === "needs_login") {
    setPlatformState(p.id, { session_status: "needs_login" });
    return { ok: false, error: `${p.name} needs you to sign in again`, url: page.url() };
  }

  const composer = page.locator(p.composerSelector).first();
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  const before = p.replySelector ? await page.locator(p.replySelector).count().catch(() => 0) : 0;

  await composer.click({ timeout: 10_000 });
  try {
    await composer.fill(text, { timeout: 10_000 });
  } catch {
    // Some editors reject fill(); typing always works, just slower.
    await composer.pressSequentially(text, { delay: 5 });
  }
  await page.waitForTimeout(300);
  if (p.sendSelector) {
    await page.locator(p.sendSelector).first().click({ timeout: 10_000 });
  } else {
    await composer.press("Enter");
  }

  if (!p.replySelector) {
    await screenshot(p, page);
    return { ok: true, reply: "", url: page.url() };
  }

  // Wait for a new reply element, then for its text to stop changing and the busy indicator to go.
  const started = Date.now();
  let lastText = "";
  let stable = 0;
  let seenNew = false;
  while (Date.now() - started < REPLY_TIMEOUT_MS) {
    await page.waitForTimeout(1_000);
    const replies = page.locator(p.replySelector);
    const n = await replies.count().catch(() => 0);
    if (n <= before) continue;
    seenNew = true;
    const txt = ((await replies.nth(n - 1).innerText({ timeout: 3_000 }).catch(() => "")) || "").trim();
    const busy = p.busySelector ? (await page.locator(p.busySelector).count().catch(() => 0)) > 0 : false;
    if (txt && txt === lastText && !busy) stable++;
    else stable = 0;
    lastText = txt || lastText;
    if (stable >= STABLE_POLLS) {
      await screenshot(p, page);
      return { ok: true, reply: lastText.slice(0, 8_000), url: page.url() };
    }
  }
  await screenshot(p, page);
  if (seenNew && lastText) return { ok: true, reply: lastText.slice(0, 8_000), partial: true, url: page.url() };
  return { ok: false, error: `${p.name} did not answer within ${Math.round(REPLY_TIMEOUT_MS / 1000)}s`, url: page.url() };
}

async function screenshot(p: PlatformConfig, page: import("playwright").Page) {
  try {
    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const file = path.join(config.screenshotDir, `${p.id}.png`);
    await page.screenshot({ path: file, timeout: 15_000 });
    setPlatformState(p.id, { screenshot_path: file });
  } catch {
    /* cosmetic */
  }
}

/** Quick "are we signed in?" check: open the app page and look, without capturing tasks. */
export async function checkConnection(p: PlatformConfig): Promise<"logged_in" | "needs_login" | "error"> {
  if (!browser.enabled || !p.appUrl) return "error";
  return browser.withLock(async () => {
    try {
      let page = await browser.consolePage(p.id);
      try {
        await page.goto(p.appUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (err) {
        // A crashed or stalled tab gets one fresh try before we call it an error.
        const msg = cleanError(err);
        if (!/Timeout|Target closed|has been closed|crashed/i.test(msg)) throw err;
        log.warn(`check ${p.id}: ${msg}; retrying on a fresh tab`);
        await browser.resetConsolePage(p.id);
        page = await browser.consolePage(p.id);
        await page.goto(p.appUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      }
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000); // let a single-page app finish deciding what to render
      const status = (await detectLoginState(p, page)) === "needs_login" ? "needs_login" : "logged_in";
      await screenshot(p, page);
      setPlatformState(p.id, { session_status: status, last_error: null });
      if (status === "logged_in") void browser.backupSessions();
      return status;
    } catch (err) {
      setPlatformState(p.id, { session_status: "error", last_error: cleanError(err) });
      return "error";
    }
  });
}
