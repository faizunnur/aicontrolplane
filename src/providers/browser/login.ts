import type { Page } from "playwright";
import { browser } from "../../browser/manager.js";
import { compilePatterns } from "../../platforms.js";
import type { PlatformConfig, SessionStatus } from "../../types.js";

/**
 * Are we signed in on this page? Decided from evidence in this order:
 *   1. landed on a sign-in URL                       → signed out
 *   2. a "signed-in only" element is present         → signed in
 *   3. a "Log in / Sign up" element is visible        → signed out
 *   4. a session cookie whose name starts with the    → signed in
 *      configured name (sites chunk cookies into .0 .1)
 *   5. we are on the app page and nothing says otherwise → signed in
 * Cookies never vote "signed out" on their own: names change, pages don't lie.
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
  return "logged_in";
}
