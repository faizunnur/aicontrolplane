import { browser } from "../../browser/manager.js";
import { guard } from "../../policy.js";
import { cleanError, isStall, PageController } from "../../browser/page.js";
import { setPlatformState } from "../../db.js";
import { logger } from "../../logger.js";
import { CancelledError, isCancelled, type RunTracker } from "../../runs.js";
import type { PlatformConfig, SessionStatus } from "../../types.js";
import type { ChatResult } from "../types.js";
import { detectLoginState } from "./login.js";

const log = logger("browser-chat");

const REPLY_TIMEOUT_MS = 120_000;
const STABLE_POLLS = 3; // reply text unchanged for this many 1s polls => finished

/**
 * Send a message to a provider exactly the way you would: open a new conversation, type it,
 * send it, wait for the answer, and read the answer back. Everything the site needs (URLs and
 * selectors) comes from the provider's configuration; every stage is reported through the step
 * tracker so the thread shows it live.
 */
export async function sendThroughBrowser(p: PlatformConfig, text: string, track?: RunTracker): Promise<ChatResult> {
  if (!browser.enabled) return { ok: false, error: "the browser is disabled on this deployment" };
  if (!p.composerSelector) return { ok: false, error: `${p.name} has no chat box configured` };
  return browser.withLock(
    async () => {
      try {
        return await sendOnce(p, text, track);
      } catch (err) {
        if (err instanceof CancelledError) return { ok: false, cancelled: true, error: err.message };
        if (isStall(err)) {
          log.warn(`chat ${p.id}: ${cleanError(err)}; retrying on a fresh tab`);
          await browser.resetConsolePage(p.id);
          try {
            return await sendOnce(p, text, track);
          } catch (err2) {
            if (err2 instanceof CancelledError) return { ok: false, cancelled: true, error: err2.message };
            return { ok: false, error: cleanError(err2) };
          }
        }
        return { ok: false, error: cleanError(err) };
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

async function sendOnce(p: PlatformConfig, text: string, step?: RunTracker): Promise<ChatResult> {
  const pc = new PageController(p.id, p.name);
  const url = p.chatUrl || p.appUrl;

  step?.start("open", `Opening ${p.name}`);
  const page = await pc.open(url);
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

  // Policy decides whether sending needs you. Under "ask" the message sits typed in the box,
  // visible in the live view, until you approve it in the thread.
  const decision = await guard({ runId: step?.runId, messageId: step?.messageId, provider: p.id, track: step }, "send_message", `Send this to ${p.name}?`, text.slice(0, 240));
  if (decision !== "approved") {
    return { ok: false, cancelled: true, error: decision === "timeout" ? `Nobody approved it within 15 minutes, so it was not sent to ${p.name}.` : `Not sent. You rejected it.`, url: page.url() };
  }

  step?.start("send", "Sending");
  if (p.sendSelector) await page.locator(p.sendSelector).first().click({ timeout: 10_000 });
  else await composer.press("Enter");
  step?.done("send");

  if (!p.replySelector) {
    await pc.screenshot(page);
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
    if (step && isCancelled(step.runId)) {
      await pc.screenshot(page);
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
      await pc.screenshot(page);
      step?.done("read", `${lastText.length} characters`);
      return { ok: true, reply: lastText.slice(0, 8_000), url: page.url() };
    }
  }
  await pc.screenshot(page);
  if (seenNew && lastText) {
    step?.done("wait", "still writing after 120s");
    step?.start("read", "Reading the answer");
    step?.done("read", `${lastText.length} characters so far`);
    return { ok: true, reply: lastText.slice(0, 8_000), partial: true, url: page.url() };
  }
  step?.fail("wait", "no answer in 120s");
  return { ok: false, error: `${p.name} did not answer within ${Math.round(REPLY_TIMEOUT_MS / 1000)}s`, url: page.url() };
}

/** Quick "are we signed in?" check: open the app page and look, without capturing tasks. */
export async function checkSignIn(p: PlatformConfig): Promise<Exclude<SessionStatus, "unknown">> {
  if (!browser.enabled || !p.appUrl) return "error";
  return browser.withLock(
    async () => {
      const pc = new PageController(p.id, p.name);
      try {
        // A single-page app needs a moment after load to decide what to render.
        const page = await pc.open(p.appUrl, { networkIdleMs: 10_000, settleMs: 1_000 });
        const status = (await detectLoginState(p, page)) === "needs_login" ? "needs_login" : "logged_in";
        await pc.screenshot(page);
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
