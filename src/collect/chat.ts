import fs from "node:fs";
import path from "node:path";
import { approvalMode, requestApproval } from "../approvals.js";
import { browser } from "../browser/manager.js";
import { config } from "../config.js";
import { setPlatformState } from "../db.js";
import { logger } from "../logger.js";
import { CancelledError, isCancelled, type StepTracker } from "../steps.js";
import type { PlatformConfig } from "../types.js";
import { cleanError, detectLoginState } from "./session.js";

const log = logger("chat");

export interface ChatResult {
  ok: boolean;
  reply?: string;
  partial?: boolean;
  url?: string;
  error?: string;
  /** The user stopped it or did not approve it. */
  cancelled?: boolean;
}

const REPLY_TIMEOUT_MS = 120_000;
const STABLE_POLLS = 3; // reply text unchanged for this many 1s polls => finished

/**
 * Send an instruction to a connected AI exactly the way you would: open a new
 * conversation, type it, send it, wait for the answer, and read the answer back.
 * Every stage is reported through the step tracker so the chat panel shows it live.
 */
export async function chatWithConnection(p: PlatformConfig, text: string, track?: StepTracker): Promise<ChatResult> {
  if (!browser.enabled) return { ok: false, error: "the browser is disabled on this deployment" };
  if (!p.composerSelector) return { ok: false, error: `${p.name} has no chat box configured` };
  return browser.withLock(
    async () => {
      try {
        return await chatOnce(p, text, track);
      } catch (err) {
        if (err instanceof CancelledError) return { ok: false, cancelled: true, error: err.message };
        const msg = cleanError(err);
        if (/Timeout|Target closed|has been closed|crashed/i.test(msg)) {
          log.warn(`chat ${p.id}: ${msg}; retrying on a fresh tab`);
          await browser.resetConsolePage(p.id);
          try {
            return await chatOnce(p, text, track);
          } catch (err2) {
            if (err2 instanceof CancelledError) return { ok: false, cancelled: true, error: err2.message };
            return { ok: false, error: cleanError(err2) };
          }
        }
        return { ok: false, error: msg };
      }
    },
    { label: `Sending to ${p.name}`, platform: p.id, messageId: track?.messageId ?? null },
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function chatOnce(p: PlatformConfig, text: string, step?: StepTracker): Promise<ChatResult> {
  step?.start("open", `Opening ${p.name}`);
  const page = await browser.consolePage(p.id);
  const url = p.chatUrl || p.appUrl;
  await page.bringToFront().catch(() => undefined);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  step?.done("open", hostOf(url));

  step?.start("check", "Checking the sign-in");
  if ((await detectLoginState(p, page)) === "needs_login") {
    setPlatformState(p.id, { session_status: "needs_login" });
    step?.fail("check", "signed out");
    return { ok: false, error: `${p.name} needs you to sign in again`, url: page.url() };
  }
  step?.done("check", "signed in");

  step?.start("type", "Typing your message");
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
  step?.done("type");

  // Manual mode: the message sits typed in the box, visible in the live view, until the user approves.
  if (step && approvalMode() === "manual") {
    step.waiting("approve", `Send this to ${p.name}?`, text.slice(0, 240));
    const decision = await requestApproval(step.messageId, "send", `Send this to ${p.name}?`, p.id);
    if (decision !== "approved") {
      step.fail("approve", decision === "timeout" ? "no answer in 15 minutes" : "rejected");
      return { ok: false, cancelled: true, error: decision === "timeout" ? `Nobody approved it within 15 minutes, so it was not sent to ${p.name}.` : `Not sent. You rejected it.`, url: page.url() };
    }
    step.done("approve", "approved by you");
  }

  step?.start("send", "Sending");
  if (p.sendSelector) {
    await page.locator(p.sendSelector).first().click({ timeout: 10_000 });
  } else {
    await composer.press("Enter");
  }
  step?.done("send");

  if (!p.replySelector) {
    await screenshot(p, page);
    step?.skip("wait", `${p.name} has no reply selector configured`);
    return { ok: true, reply: "", url: page.url() };
  }

  // Wait for a new reply element, then for its text to stop changing and the busy indicator to go.
  step?.start("wait", `Waiting for ${p.name} to answer`);
  const started = Date.now();
  let lastText = "";
  let stable = 0;
  let seenNew = false;
  while (Date.now() - started < REPLY_TIMEOUT_MS) {
    await page.waitForTimeout(1_000);
    if (step && isCancelled(step.messageId)) {
      await screenshot(p, page);
      step.fail("wait", "stopped by you");
      return { ok: false, cancelled: true, error: `You stopped waiting. It was sent to ${p.name}; the answer is in its tab.`, url: page.url() };
    }
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
      step?.done("wait", `${Math.round((Date.now() - started) / 1000)}s`);
      step?.start("read", "Reading the answer");
      await screenshot(p, page);
      step?.done("read", `${lastText.length} characters`);
      return { ok: true, reply: lastText.slice(0, 8_000), url: page.url() };
    }
  }
  await screenshot(p, page);
  if (seenNew && lastText) {
    step?.done("wait", "still writing after 120s");
    step?.start("read", "Reading the answer");
    step?.done("read", `${lastText.length} characters so far`);
    return { ok: true, reply: lastText.slice(0, 8_000), partial: true, url: page.url() };
  }
  step?.fail("wait", "no answer in 120s");
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
  return browser.withLock(
    async () => {
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
    },
    { label: `Checking ${p.name}`, platform: p.id },
  );
}
