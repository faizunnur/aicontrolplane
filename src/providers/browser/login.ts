import type { Page } from "playwright";
import { browser } from "../../browser/manager.js";
import { compilePatterns } from "../../platforms.js";
import type { PlatformConfig, SessionStatus } from "../../../packages/core/src/index.js";

/**
 * Are we signed in on this page? Decided from evidence in this order:
 *   1. landed on a sign-in URL                       → signed out
 *   2. a "signed-in only" element is present         → signed in
 *   3. a "Log in / Sign up" element is visible        → signed out
 *   4. a session cookie whose name starts with the    → signed in
 *      configured name (sites chunk cookies into .0 .1)
 *   5. the configured composer is on the page          → signed in
 *   6. signed-in markers are configured but absent     → unknown
 *   7. nothing is configured to judge by              → unknown
 * Cookies never vote "signed out" on their own: names change, pages don't lie. And no page
 * ever votes "signed in" without evidence: a provider with nothing to judge by is unknown,
 * not connected — its sidebar card must not claim a session that was never seen. The chat
 * path still proceeds on "unknown" (the composer's presence is the verdict there).
 */
export async function detectLoginState(p: PlatformConfig, page: Page, extra: { unauthorized?: boolean } = {}): Promise<SessionStatus> {
  const url = page.url();
  if (compilePatterns(p.loginUrlPatterns).some((r) => r.test(url))) return "needs_login";
  if (extra.unauthorized) return "needs_login";

  if (p.loggedInSelector) {
    const n = await page.locator(p.loggedInSelector).count().catch(() => 0);
    if (n > 0) return "logged_in";
  }
  if (p.loggedOutSelector) {
    const visible = await page
      .locator(p.loggedOutSelector)
      .first()
      .isVisible({ timeout: 1_500 })
      .catch(() => false);
    if (visible) return "needs_login";
  }
  if (p.sessionCookie) {
    const cookies = await browser.cookies(p.cookieDomain || undefined);
    if (cookies.some((c) => c.name === p.sessionCookie || c.name.startsWith(p.sessionCookie + "."))) return "logged_in";
  }
  if (p.composerSelector) {
    const n = await page.locator(p.composerSelector).count().catch(() => 0);
    if (n > 0) return "logged_in";
  }
  return "unknown";
}

export interface ChallengeState {
  /** A bot check is on the page. */
  challenge: "cloudflare" | null;
  /** It has already told the visitor it failed. */
  blocked: boolean;
}

/**
 * Is the page behind a bot check, and has it already failed? Cloudflare's Turnstile widget and
 * interstitial are recognised; a failed one shows "Verification failed". A remote-controlled
 * browser scores badly on these, which is what the desktop sign-in mode is for.
 */
export async function detectChallenge(page: Page): Promise<ChallengeState> {
  const title = await page.title().catch(() => "");
  const widget = await page.locator('iframe[src*="challenges.cloudflare.com"], #challenge-running, #challenge-error-text, #challenge-stage, .cf-turnstile, [id^="cf-chl"]').count().catch(() => 0);
  const failed = await page.getByText(/verification failed|please refresh the page and try again|checking if the site connection is secure/i).count().catch(() => 0);
  const challenge = widget > 0 || failed > 0 || /just a moment|attention required/i.test(title) ? "cloudflare" : null;
  return { challenge, blocked: failed > 0 || /attention required/i.test(title) };
}
