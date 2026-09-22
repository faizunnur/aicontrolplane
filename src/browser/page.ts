import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { config } from "../config.js";
import { setPlatformState } from "../db.js";
import { logger } from "../logger.js";
import { browser } from "./manager.js";

const log = logger("page");

/** Playwright errors carry ANSI colour codes and multi-line call logs; keep the readable first line. */
export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw.replace(/\u001b\[[0-9;]*m/g, "");
  const first = stripped.split("\n").find((l) => l.trim()) ?? stripped;
  return first.trim().slice(0, 500);
}

/** A navigation or interaction that stalled: a wedged tab, a crash, a closed target. Worth one retry on a fresh tab. */
export function isStall(err: unknown): boolean {
  return /Timeout|Target closed|has been closed|crashed/i.test(cleanError(err));
}

export interface OpenOptions {
  /** Navigation timeout in ms. */
  timeout?: number;
  /** How long to wait for the network to go quiet after load; 0 skips the wait. */
  networkIdleMs?: number;
  /** Extra time for single-page apps to finish rendering. */
  settleMs?: number;
  /** Called with the tab right before it navigates (attach response listeners here). Called again if the tab is replaced. */
  beforeNavigate?: (page: Page) => void;
}

/**
 * The one way provider code drives a tab: open a url (replacing a stalled tab once), let the
 * page settle, take the provider's screenshot. Provider adapters and the browser flows built on
 * them use this instead of talking to Playwright's navigation directly, so the retry and
 * screenshot rules live in exactly one place. Callers hold the browser lock.
 */
export class PageController {
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}

  /** The provider's tab, without navigating. */
  current(): Promise<Page> {
    return browser.consolePage(this.id);
  }

  async open(url: string, opts: OpenOptions = {}): Promise<Page> {
    const timeout = opts.timeout ?? 45_000;
    let page = await browser.consolePage(this.id);
    await page.bringToFront().catch(() => undefined);
    opts.beforeNavigate?.(page);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } catch (err) {
      if (!isStall(err)) throw err;
      log.warn(`${this.id}: navigation to ${url} stalled (${cleanError(err)}); retrying on a fresh tab`);
      await browser.resetConsolePage(this.id);
      page = await browser.consolePage(this.id);
      opts.beforeNavigate?.(page);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    }
    if (opts.networkIdleMs !== 0) await page.waitForLoadState("networkidle", { timeout: opts.networkIdleMs ?? 15_000 }).catch(() => undefined);
    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
    return page;
  }

  /** Screenshot the tab into the provider's screenshot file and remember it. Never throws. */
  async screenshot(page?: Page): Promise<string | null> {
    try {
      const p = page ?? (await this.current());
      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const file = path.join(config.screenshotDir, `${this.id}.png`);
      await p.screenshot({ path: file, fullPage: false, timeout: 15_000 });
      setPlatformState(this.id, { screenshot_path: file });
      return file;
    } catch (err) {
      log.warn(`screenshot failed for ${this.id}`, err);
      return null;
    }
  }

  /** Screenshot the tab, opening a fallback url first when the tab is still blank. */
  async screenshotOrOpen(fallbackUrl: string): Promise<string | null> {
    const page = await this.current();
    if (page.url() === "about:blank" && fallbackUrl) await this.open(fallbackUrl, { networkIdleMs: 10_000 }).catch(() => undefined);
    return this.screenshot();
  }
}
