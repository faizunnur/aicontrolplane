import type { Page } from "playwright";
import { browser } from "../../browser/manager.js";
import { cleanError, isStall, PageController } from "../../browser/page.js";
import { setPlatformState } from "../../db.js";
import { logger } from "../../logger.js";
import { CancelledError, isCancelled, type RunTracker } from "../../runs.js";
import type { PlatformConfig, SessionStatus } from "../../../packages/core/src/index.js";
import type { ChatResult } from "../types.js";
import { detectChallenge, detectLoginState } from "./login.js";

const log = logger("browser-chat");

const REPLY_TIMEOUT_MS = 120_000;
const STABLE_POLLS = 3; // reply text unchanged for this many 1s polls => finished
const MAX_REPLY_CHARS = 8_000;

/** A reply is cut, never silently: the cut is marked so the reader knows there was more. */
const clipReply = (s: string) => (s.length > MAX_REPLY_CHARS ? s.slice(0, MAX_REPLY_CHARS) + "\n…[truncated]" : s);

/**
 * Send a message to a provider exactly the way you would: open the conversation (the thread
 * the control-plane conversation already holds there, or a new one), type it, send it, wait
 * for the answer, and read the answer back. Everything the site needs (URLs and selectors)
 * comes from the provider's configuration; every stage is reported through the step tracker
 * so the thread shows it live.
 */
export async function sendThroughBrowser(p: PlatformConfig, text: string, track?: RunTracker, threadUrl?: string | null): Promise<ChatResult> {
  if (!browser.enabled) return { ok: false, error: "the browser is disabled on this deployment" };
  if (!p.composerSelector) return { ok: false, error: `${p.name} has no chat box configured` };
  return browser.withLock(
    async () => {
      try {
        return await sendOnce(p, text, track, threadUrl);
      } catch (err) {
        if (err instanceof CancelledError) return { ok: false, cancelled: true, error: err.message };
        if (isStall(err)) {
          log.warn(`chat ${p.id}: ${cleanError(err)}; retrying on a fresh tab`);
          await browser.resetConsolePage(p.id);
          try {
            return await sendOnce(p, text, track, threadUrl);
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

/**
 * The page is behind a bot check: say so honestly instead of dying as a generic timeout. The
 * platform state has no dedicated "challenge" status, so the closest honest one — needs_login,
 * with the challenge named in last_error — carries it, and the desktop sign-in flow (which
 * passes these checks) is the way back in.
 */
async function challengeFailure(p: PlatformConfig, page: Page, step: RunTracker | undefined, key: string): Promise<ChatResult> {
  await setPlatformState(p.id, { session_status: "needs_login", last_error: `${p.name} is showing a human-verification challenge` });
  await step?.fail(key, "human-verification challenge");
  return { ok: false, error: `${p.name} is showing a human-verification challenge — open the live view or re-run sign-in.`, url: page.url() };
}

async function sendOnce(p: PlatformConfig, text: string, step?: RunTracker, threadUrl?: string | null): Promise<ChatResult> {
  const pc = new PageController(p.id, p.name);
  const fresh = p.chatUrl || p.appUrl;
  // The conversation's own chat at the provider first; a thread that will not come back
  // (deleted there, another account, a changed URL scheme) falls back to a new chat rather
  // than failing the message.
  const targets = threadUrl && threadUrl !== fresh ? [threadUrl, fresh] : [fresh];

  let page!: Page;
  let composer!: ReturnType<Page["locator"]>;
  let login: SessionStatus = "unknown";
  for (let attempt = 0; attempt < targets.length; attempt++) {
    const url = targets[attempt];
    const continuing = url !== fresh;
    await step?.start("open", continuing ? `Reopening your ${p.name} chat` : attempt > 0 ? `Opening a new ${p.name} chat` : `Opening ${p.name}`);
    page = await pc.open(url);
    await step?.done("open", hostOf(url));

    if (attempt === 0) {
      // The sign-in is a property of the site, not the page: checking it once is enough.
      await step?.start("check", "Checking the sign-in");
      login = await detectLoginState(p, page);
      if (login === "needs_login") {
        await setPlatformState(p.id, { session_status: "needs_login" });
        await step?.fail("check", "signed out");
        return { ok: false, error: `${p.name} needs you to sign in again`, url: page.url() };
      }
      if (login === "unknown") {
        // None of the provider's markers answered either way. Look for a bot check before
        // trusting the page, then proceed-but-verify: the composer wait below is the verdict.
        if ((await detectChallenge(page)).challenge) return challengeFailure(p, page, step, "check");
        await step?.done("check", "no sign-in markers answered; proceeding carefully");
      } else {
        await step?.done("check", "signed in");
      }
    }

    await step?.start("type", "Typing your message");
    composer = page.locator(p.composerSelector).first();
    try {
      await composer.waitFor({ state: "visible", timeout: 20_000 });
      break;
    } catch (err) {
      // The composer never appeared — the classic face of a Cloudflare interstitial. Name it
      // when it IS one; otherwise a vanished thread gets one try on a new chat, and a real
      // timeout flows to the ordinary handling.
      if ((await detectChallenge(page)).challenge) return challengeFailure(p, page, step, "type");
      if (attempt < targets.length - 1) {
        log.warn(`chat ${p.id}: the saved thread at ${threadUrl} shows no composer; starting a new chat`);
        continue;
      }
      throw err;
    }
  }
  // The composer's presence is the verdict the "unknown" login check deferred to: record it,
  // so a provider with no sign-in markers becomes Connected from evidence, never by default.
  if (login === "unknown") await setPlatformState(p.id, { session_status: "logged_in", last_error: null });
  const before = p.replySelector ? await page.locator(p.replySelector).count().catch(() => 0) : 0;
  await composer.click({ timeout: 10_000 });
  try {
    await composer.fill(text, { timeout: 10_000 });
  } catch {
    // Some editors reject fill(); typing always works, just slower.
    await composer.pressSequentially(text, { delay: 5 });
  }
  await page.waitForTimeout(300);
  await step?.done("type");

  // Whether sending needed approval was decided BEFORE any browser work (the run parks on
  // its approval without holding a tab, let alone the whole browser). By here it may send.
  await step?.start("send", "Sending");
  if (p.sendSelector) await page.locator(p.sendSelector).first().click({ timeout: 10_000 });
  else await composer.press("Enter");
  await step?.done("send");

  if (!p.replySelector) {
    await pc.screenshot(page);
    await step?.skip("wait", `${p.name} has no reply selector configured`);
    return { ok: true, reply: "", url: page.url() };
  }

  // Wait for a new reply element, then for its text to stop changing and the busy indicator to go.
  await step?.start("wait", `Waiting for ${p.name} to answer`);
  const started = Date.now();
  let lastText = "";
  let stable = 0;
  let seenNew = false;
  while (Date.now() - started < REPLY_TIMEOUT_MS) {
    await page.waitForTimeout(1_000);
    if (step && (await isCancelled(step.runId))) {
      await pc.screenshot(page);
      await step.fail("wait", "stopped by you");
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
      await step?.done("wait", `${Math.round((Date.now() - started) / 1000)}s`);
      await step?.start("read", "Reading the answer");
      await pc.screenshot(page);
      await step?.done("read", `${lastText.length} characters`);
      return { ok: true, reply: clipReply(lastText), url: page.url() };
    }
  }
  await pc.screenshot(page);
  if (seenNew && lastText) {
    await step?.done("wait", "still writing after 120s");
    await step?.start("read", "Reading the answer");
    await step?.done("read", `${lastText.length} characters so far`);
    return { ok: true, reply: clipReply(lastText), partial: true, url: page.url() };
  }
  // Nothing ever answered. A bot check that appeared after the send is the likeliest silent
  // culprit; name it instead of blaming the provider's speed.
  if ((await detectChallenge(page)).challenge) return challengeFailure(p, page, step, "wait");
  await step?.fail("wait", "no answer in 120s");
  return { ok: false, error: `${p.name} did not answer within ${Math.round(REPLY_TIMEOUT_MS / 1000)}s`, url: page.url() };
}

/** Quick "are we signed in?" check: open the app page and look, without capturing tasks. */
export async function checkSignIn(p: PlatformConfig): Promise<SessionStatus> {
  if (!browser.enabled || !p.appUrl) return "error";
  return browser.withLock(
    async () => {
      const pc = new PageController(p.id, p.name);
      try {
        // A single-page app needs a moment after load to decide what to render.
        const page = await pc.open(p.appUrl, { networkIdleMs: 10_000, settleMs: 1_000 });
        const login = await detectLoginState(p, page);
        // "unknown" is ruled a bot check when one is on the page (an interstitial shows none
        // of the provider's markers either); otherwise it STAYS unknown — a check that saw
        // no evidence must not paint the card "Connected". A send still proceeds on unknown,
        // and its success is what flips the state to logged_in.
        const challenged = login === "unknown" && (await detectChallenge(page)).challenge !== null;
        const status: SessionStatus = login === "needs_login" || challenged ? "needs_login" : login;
        await pc.screenshot(page);
        await setPlatformState(p.id, { session_status: status, last_error: challenged ? `${p.name} is showing a human-verification challenge` : null });
        if (status === "logged_in") void browser.backupSessions();
        return status;
      } catch (err) {
        await setPlatformState(p.id, { session_status: "error", last_error: cleanError(err) });
        return "error";
      }
    },
    { label: `Checking ${p.name}`, platform: p.id },
  );
}
