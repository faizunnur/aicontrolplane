import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Cookie, type Page } from "playwright";
import { config } from "../config.js";
import { logger } from "../logger.js";

const log = logger("browser");

/**
 * One persistent Chromium profile for every platform. Cookies are per-domain
 * anyway, so a single profile keeps memory low and gives the VNC screen a
 * single window with one tab per platform ("console tabs").
 */
class BrowserManager {
  readonly enabled = config.browser.enabled;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private consolePages = new Map<string, Page>();
  private queue: Promise<unknown> = Promise.resolve();

  isRunning() {
    return this.context !== null;
  }

  async getContext(): Promise<BrowserContext> {
    if (!this.enabled) throw new Error("browser is disabled (BROWSER_ENABLED=false)");
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launch().finally(() => (this.launching = null));
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    fs.mkdirSync(config.profileDir, { recursive: true });
    // A crashed or killed Chromium leaves singleton lock files behind; they block the next launch.
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]) {
      const p = path.join(config.profileDir, f);
      try {
        fs.rmSync(p, { force: true });
      } catch (err) {
        log.warn(`could not remove stale ${f}`, err);
      }
    }
    const [w, h] = config.browser.windowSize;
    log.info(`launching chromium (headless=${config.browser.headless}) profile=${config.profileDir}`);
    const ctx = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.browser.headless,
      channel: config.browser.channel,
      viewport: config.browser.headless ? { width: w, height: h } : null,
      locale: "en-US",
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Encrypt cookies with the portable "basic" store, never a machine keyring, so the
        // profile stays readable when the container is rebuilt on another host.
        "--password-store=basic",
        "--disable-blink-features=AutomationControlled",
        `--window-size=${w},${h}`,
        "--window-position=0,0",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    ctx.on("close", () => {
      log.warn("browser context closed");
      this.context = null;
      this.consolePages.clear();
    });
    this.context = ctx;
    await this.restoreSessionsIfEmpty(ctx);
    return ctx;
  }

  /* ---------- session backup: survives a lost or corrupted profile ---------- */

  private get backupFile() {
    return path.join(config.dataDir, "sessions.json");
  }

  /** Write cookies + local storage to the volume. Called after successful syncs and on shutdown. */
  async backupSessions(): Promise<number> {
    if (!this.context) return 0;
    try {
      const state = await this.context.storageState();
      const tmp = this.backupFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.backupFile);
      return state.cookies.length;
    } catch (err) {
      log.warn("session backup failed", err);
      return 0;
    }
  }

  /** If the profile came up with no cookies but a backup exists, restore it. */
  private async restoreSessionsIfEmpty(ctx: BrowserContext) {
    try {
      if (!fs.existsSync(this.backupFile)) return;
      const existing = await ctx.cookies();
      if (existing.length > 0) return;
      const state = JSON.parse(fs.readFileSync(this.backupFile, "utf8")) as { cookies?: Cookie[] };
      const cookies = (state.cookies ?? []).filter((c) => c && c.name && c.domain);
      if (!cookies.length) return;
      await ctx.addCookies(cookies);
      log.warn(`profile had no cookies; restored ${cookies.length} from sessions.json`);
    } catch (err) {
      log.warn("session restore failed", err);
    }
  }

  /** How many cookies the profile holds per platform domain, for the storage diagnostics. */
  async cookieCounts(domains: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (!this.context) return out;
    const all = await this.context.cookies().catch(() => [] as Cookie[]);
    for (const d of domains) out[d] = all.filter((c) => c.domain.includes(d)).length;
    return out;
  }

  /** Serialise browser work so a sync never navigates a tab another job is using. */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The long-lived tab for a platform. Created on demand; navigated when url is given. */
  async consolePage(platformId: string, url?: string): Promise<Page> {
    const ctx = await this.getContext();
    let page = this.consolePages.get(platformId);
    if (!page || page.isClosed()) {
      // Reuse the blank tab the persistent context opens on launch; otherwise open a new one.
      const owned = new Set(this.consolePages.values());
      const spare = ctx.pages().find((p) => !owned.has(p) && !p.isClosed() && p.url() === "about:blank");
      page = spare ?? (await ctx.newPage());
      this.consolePages.set(platformId, page);
      const tracked = page;
      tracked.on("close", () => {
        if (this.consolePages.get(platformId) === tracked) this.consolePages.delete(platformId);
      });
    }
    if (url) {
      await page.bringToFront().catch(() => undefined);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0];
        if (!/Timeout|Target closed|has been closed|crashed/i.test(msg)) throw err;
        log.warn(`navigation to ${url} stalled (${msg}); retrying on a fresh tab`);
        await this.resetConsolePage(platformId);
        page = await ctx.newPage();
        this.consolePages.set(platformId, page);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      }
    }
    return page;
  }

  /** Close a platform's console tab so the next consolePage() call starts from a fresh one. */
  async resetConsolePage(platformId: string) {
    const page = this.consolePages.get(platformId);
    this.consolePages.delete(platformId);
    if (page && !page.isClosed()) await page.close().catch(() => undefined);
  }

  async cookies(domainIncludes?: string): Promise<Cookie[]> {
    const ctx = await this.getContext();
    const all = await ctx.cookies();
    return domainIncludes ? all.filter((c) => c.domain.includes(domainIncludes)) : all;
  }

  async importState(state: { cookies?: Cookie[] }): Promise<number> {
    const ctx = await this.getContext();
    const cookies = (state.cookies ?? []).filter((c) => c && c.name && c.domain);
    if (cookies.length) await ctx.addCookies(cookies);
    log.info(`imported ${cookies.length} cookies`);
    return cookies.length;
  }

  async exportState() {
    const ctx = await this.getContext();
    return ctx.storageState();
  }

  async status() {
    const pages: { platform: string; url: string; title: string }[] = [];
    for (const [platform, page] of this.consolePages) {
      if (page.isClosed()) continue;
      pages.push({ platform, url: page.url(), title: await page.title().catch(() => "") });
    }
    return { enabled: this.enabled, running: this.isRunning(), headless: config.browser.headless, pages };
  }

  async close() {
    const ctx = this.context;
    if (!ctx) return;
    await this.backupSessions();
    this.context = null;
    this.consolePages.clear();
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Is DATA_DIR on a mounted volume? On Linux we read /proc/mounts; anywhere else we
 * cannot tell and return null. A false here means logins vanish on redeploy.
 */
export function storageInfo(): { dataDir: string; persistent: boolean | null; mount: string | null; backupAt: string | null } {
  let persistent: boolean | null = null;
  let mount: string | null = null;
  try {
    if (process.platform === "linux" && fs.existsSync("/proc/mounts")) {
      const mounts = fs
        .readFileSync("/proc/mounts", "utf8")
        .split("\n")
        .map((l) => l.split(" ")[1])
        .filter(Boolean)
        .filter((m) => m !== "/" && !m.startsWith("/proc") && !m.startsWith("/sys") && !m.startsWith("/dev") && m !== "/etc/hosts" && m !== "/etc/hostname" && m !== "/etc/resolv.conf");
      const dir = path.resolve(config.dataDir);
      mount = mounts.filter((m) => dir === m || dir.startsWith(m + "/")).sort((a, b) => b.length - a.length)[0] ?? null;
      persistent = mount !== null;
    }
  } catch {
    persistent = null;
  }
  let backupAt: string | null = null;
  try {
    const f = path.join(config.dataDir, "sessions.json");
    if (fs.existsSync(f)) backupAt = fs.statSync(f).mtime.toISOString();
  } catch {
    backupAt = null;
  }
  return { dataDir: config.dataDir, persistent, mount, backupAt };
}

export const browser = new BrowserManager();

/** Small shared counter so the sync loop can yield while someone is using the VNC screen. */
export const vncState = { connections: 0, lastActivityAt: 0 };
