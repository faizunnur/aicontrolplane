import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Cookie, type Page } from "playwright";
import { bus } from "../bus.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { persistStatus, saveToDatabase } from "../persist.js";
import { cookieMatchesDomain, type StoredCookie, type StoredOrigin } from "../providers/browser/domains.js";
import { chromeInstallCandidates } from "./executable.js";

const log = logger("browser");

/** A sign-in happening in a plain browser window on the cloud desktop, outside any automation. */
export interface DesktopSignIn {
  platform: string;
  url: string;
  since: string;
  pid: number | null;
}

const DESKTOP_SIGNIN_TIMEOUT_MS = Math.max(1, Number(process.env.DESKTOP_SIGNIN_TIMEOUT_MIN) || 10) * 60_000;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The browser binary the app drives. BROWSER_EXECUTABLE wins; then the channel's standard
 * install location (Google Chrome in the Docker image); then Playwright's bundled Chromium.
 * The same binary is used for automation and for desktop sign-ins, so one profile serves both.
 */
export function resolveExecutable(): { path: string; source: "env" | "channel" | "bundled" } {
  const env = process.env.BROWSER_EXECUTABLE;
  if (env && fs.existsSync(env)) return { path: env, source: "env" };
  if (config.browser.channel === "chrome") {
    const found = chromeInstallCandidates().find((c) => c && fs.existsSync(c));
    if (found) return { path: found, source: "channel" };
    log.warn("BROWSER_CHANNEL=chrome but Google Chrome was not found; using the bundled Chromium");
  }
  return { path: chromium.executablePath(), source: "bundled" };
}

/** Software WebGL under a virtual display: a browser without any WebGL is an oddity sites notice. */
const GPU_ARGS = process.platform === "linux" ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [];

export interface BusyTask {
  /** Short human label: "Sending to ChatGPT", "Checking Claude", "Looking at Grok's tasks". */
  label: string;
  platform: string | null;
  /** Message the task belongs to, when it is a chat delivery. */
  messageId: number | null;
  since: string;
}

export interface BrowserSnapshot {
  enabled: boolean;
  running: boolean;
  headless: boolean;
  /** Platform whose tab is in front (what the live view follows). */
  active: string | null;
  busy: BusyTask | null;
  pages: { platform: string; url: string; title: string }[];
  /** A sign-in in progress in a plain browser window on the cloud desktop, if any. */
  signIn: DesktopSignIn | null;
  /** Rises with every snapshot. The page receives state over two channels (event stream, live-view socket) and drops any snapshot older than the one it has. */
  seq: number;
}

/**
 * One persistent Chromium profile for every platform. Cookies are per-domain
 * anyway, so a single profile keeps memory low and gives the live view a
 * single window with one tab per platform ("console tabs").
 */
class BrowserManager {
  readonly enabled = config.browser.enabled;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private consolePages = new Map<string, Page>();
  private titles = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private activePlatform: string | null = null;
  private busyTask: BusyTask | null = null;
  private desktop: DesktopSignIn | null = null;
  private desktopDone: ReturnType<typeof deferred<"finished" | "cancelled">> | null = null;
  private desktopJob: Promise<void> | null = null;

  isRunning() {
    return this.context !== null;
  }

  /** The desktop sign-in in progress, if any. */
  get signIn() {
    return this.desktop;
  }

  /** Platform whose tab is in front. */
  get active() {
    return this.activePlatform;
  }
  /** The job holding the browser lock right now, if any. */
  get busy() {
    return this.busyTask;
  }

  /** What the UI needs to draw the browser panel. Synchronous, so it can ride on every bus event. */
  snapshot(): BrowserSnapshot {
    const pages: BrowserSnapshot["pages"] = [];
    for (const [platform, page] of this.consolePages) {
      if (page.isClosed()) continue;
      pages.push({ platform, url: page.url(), title: this.titles.get(platform) ?? "" });
    }
    return { enabled: this.enabled, running: this.isRunning(), headless: config.browser.headless, active: this.activePlatform, busy: this.busyTask, pages, signIn: this.desktop, seq: ++this.snapshotSeq };
  }
  private snapshotSeq = 0;

  /* ---------- desktop sign-in: a plain browser window, no automation attached ---------- */

  /**
   * Sites that gate their sign-in page with a bot check score a remote-controlled browser badly.
   * For those, the automation steps aside: the profile is opened in a plain window on the cloud
   * display (the same binary, the same cookies, no debugging session, no automation flags), you
   * sign in through the desktop view, and the automation takes the profile back afterwards.
   */
  canDesktopSignIn(): { ok: boolean; reason?: string } {
    if (!this.enabled) return { ok: false, reason: "the browser is disabled on this deployment" };
    if (config.browser.headless) return { ok: false, reason: "this deployment runs the browser without a display, so there is no desktop to sign in on; import a session from your own computer instead" };
    return { ok: true };
  }

  async startDesktopSignIn(platformId: string, name: string, url: string): Promise<DesktopSignIn> {
    const can = this.canDesktopSignIn();
    if (!can.ok) throw Object.assign(new Error(can.reason), { status: 409 });
    // Asking again for the same provider (a reloaded page, a second tab) joins the sign-in in progress.
    if (this.desktop && this.desktop.platform === platformId) return this.desktop;
    if (this.desktop) throw Object.assign(new Error(`a sign-in to ${this.desktop.platform} is already in progress; finish or cancel it first`), { status: 409 });
    const started = deferred<DesktopSignIn>();
    const done = deferred<"finished" | "cancelled">();
    this.desktopDone = done;
    this.desktopJob = this.withLock(
      async () => {
        let child: ChildProcess | null = null;
        try {
          await this.close(); // automation out of the way; sessions backed up first
          const exe = resolveExecutable();
          const [w, h] = config.browser.windowSize;
          const args = [
            `--user-data-dir=${config.profileDir}`,
            "--password-store=basic",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-session-crashed-bubble",
            "--hide-crash-restore-bubble",
            `--window-size=${w},${h}`,
            "--window-position=0,0",
            "--lang=en-US",
            ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage", ...GPU_ARGS] : []),
            url,
          ];
          log.info(`desktop sign-in for ${platformId}: opening ${exe.path} (${exe.source}) on ${process.env.DISPLAY ?? "the desktop"}`);
          child = spawn(exe.path, args, { stdio: "ignore", env: process.env });
          const state: DesktopSignIn = { platform: platformId, url, since: new Date().toISOString(), pid: child.pid ?? null };
          this.desktop = state;
          this.announce();
          child.on("exit", () => {
            // The user closed the window themselves: that counts as finished.
            if (this.desktop === state) done.resolve("finished");
          });
          child.on("error", (err) => {
            log.error("desktop sign-in browser failed to start", err);
            started.reject(err);
            done.resolve("cancelled");
          });
          started.resolve(state);
          const outcome = await Promise.race([done.promise, new Promise<"cancelled">((r) => setTimeout(() => r("cancelled"), DESKTOP_SIGNIN_TIMEOUT_MS).unref?.())]);
          log.info(`desktop sign-in for ${platformId} ${outcome}`);
          await stopChild(child, outcome === "finished" ? 10_000 : 4_000);
        } catch (err) {
          started.reject(err);
          throw err;
        } finally {
          this.desktop = null;
          this.desktopDone = null;
          this.announce();
        }
      },
      { label: `Signing in to ${name}`, platform: platformId },
    );
    this.desktopJob.catch(() => undefined);
    return started.promise;
  }

  /** The user says they are signed in: close the plain window and give the profile back to the automation. */
  async finishDesktopSignIn(): Promise<boolean> {
    if (!this.desktopDone) return false;
    this.desktopDone.resolve("finished");
    await this.desktopJob?.catch(() => undefined);
    return true;
  }

  async cancelDesktopSignIn(): Promise<boolean> {
    if (!this.desktopDone) return false;
    this.desktopDone.resolve("cancelled");
    await this.desktopJob?.catch(() => undefined);
    return true;
  }

  private announce() {
    bus.emit("browser", this.snapshot());
  }

  /** The console tab of a platform, if one is open. */
  pageOf(platformId: string): Page | undefined {
    const page = this.consolePages.get(platformId);
    return page && !page.isClosed() ? page : undefined;
  }

  /** Bring a platform's tab to the front (the live view shows the front tab in headed mode). */
  async bringToFront(platformId: string): Promise<boolean> {
    const page = this.pageOf(platformId);
    if (!page) return false;
    await page.bringToFront().catch(() => undefined);
    this.setActive(platformId);
    return true;
  }

  private setActive(platformId: string | null) {
    if (this.activePlatform === platformId) return;
    this.activePlatform = platformId;
    this.announce();
  }

  private track(platformId: string, page: Page) {
    const isMain = (f: import("playwright").Frame) => f === page.mainFrame();
    page.on("framenavigated", (f) => {
      if (!isMain(f)) return;
      log.debug(`${platformId} tab → ${f.url()}`);
      this.announce();
    });
    page.on("crash", () => log.error(`${platformId} tab crashed; the next job opens a fresh one`));
    page.on("load", () => {
      page
        .title()
        .then((t) => {
          this.titles.set(platformId, t);
          this.announce();
        })
        .catch(() => undefined);
    });
    page.on("close", () => {
      if (this.consolePages.get(platformId) === page) this.consolePages.delete(platformId);
      this.titles.delete(platformId);
      if (this.activePlatform === platformId) this.activePlatform = null;
      this.announce();
    });
  }

  async getContext(): Promise<BrowserContext> {
    if (!this.enabled) throw new Error("browser is disabled (BROWSER_ENABLED=false)");
    if (this.context) return this.context;
    if (this.desktop) throw new Error(`a sign-in to ${this.desktop.platform} is in progress on the desktop; try again when it is finished`);
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
    const exe = resolveExecutable();
    log.info(`launching browser (headless=${config.browser.headless}, ${exe.source}: ${exe.path}) profile=${config.profileDir}`);
    const ctx = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.browser.headless,
      // The same binary a desktop sign-in opens, so the profile never changes hands between versions.
      ...(exe.source === "bundled" ? {} : { executablePath: exe.path }),
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
        ...GPU_ARGS,
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    ctx.on("close", () => {
      log.warn("browser context closed");
      this.context = null;
      this.consolePages.clear();
      this.titles.clear();
      this.activePlatform = null;
      this.announce();
    });
    this.context = ctx;
    await this.restoreSessionsIfEmpty(ctx);
    this.announce();
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
      void saveToDatabase().catch(() => undefined);
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

  /**
   * Serialise browser work so a sync never navigates a tab another job is using.
   * The task label is shown in the live view while the job runs ("Sending to ChatGPT").
   */
  withLock<T>(fn: () => Promise<T>, task?: { label: string; platform?: string | null; messageId?: number | null }): Promise<T> {
    // A desktop sign-in holds the browser for as long as its window is open, minutes at a time. Work that
    // arrives meanwhile is refused at once with the reason, rather than queued behind it in silence.
    if (this.desktop) return Promise.reject(Object.assign(new Error(`a sign-in to ${this.desktop.platform} is in progress on the cloud desktop; finish or cancel it first`), { status: 409 }));
    const job = () => this.runLocked(fn, task);
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runLocked<T>(fn: () => Promise<T>, task?: { label: string; platform?: string | null; messageId?: number | null }): Promise<T> {
    this.busyTask = { label: task?.label ?? "Working", platform: task?.platform ?? null, messageId: task?.messageId ?? null, since: new Date().toISOString() };
    this.announce();
    try {
      return await fn();
    } finally {
      this.busyTask = null;
      this.announce();
    }
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
      this.track(platformId, page);
      this.announce();
    }
    if (url) {
      await page.bringToFront().catch(() => undefined);
      this.setActive(platformId);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0];
        if (!/Timeout|Target closed|has been closed|crashed/i.test(msg)) throw err;
        log.warn(`navigation to ${url} stalled (${msg}); retrying on a fresh tab`);
        await this.resetConsolePage(platformId);
        page = await ctx.newPage();
        this.consolePages.set(platformId, page);
        this.track(platformId, page);
        this.setActive(platformId);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      }
    } else {
      // Callers that take the page without a url are about to work in it: it becomes the front tab.
      this.setActive(platformId);
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

  /**
   * Replace one provider's session with what the user's own computer captured: its cookies for the
   * provider's domains (the old ones for those domains go first, so a stale session cannot shadow the
   * new one) and, best effort, its localStorage for those origins. Runs under the lock, so a desktop
   * sign-in holding the browser answers with the usual refusal instead of racing it.
   */
  async importProviderState(p: { id: string; name: string }, domains: string[], state: { cookies: StoredCookie[]; origins: StoredOrigin[] }): Promise<{ cookies: number; origins: number; cleared: number }> {
    return this.withLock(
      async () => {
        const ctx = await this.getContext();
        const before = await ctx.cookies();
        const cleared = before.filter((c) => cookieMatchesDomain(c.domain, domains)).length;
        for (const d of domains) {
          const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          await ctx.clearCookies({ domain: new RegExp(`(^|\\.)${escaped}$`, "i") }).catch((err) => log.warn(`could not clear cookies for ${d}`, err));
        }
        if (state.cookies.length) await ctx.addCookies(state.cookies);
        let origins = 0;
        for (const o of state.origins) {
          const page = await ctx.newPage();
          try {
            await page.goto(o.origin, { waitUntil: "commit", timeout: 15_000 });
            await page.evaluate((entries) => {
              for (const e of entries) localStorage.setItem(e.name, e.value);
            }, o.localStorage);
            origins++;
          } catch (err) {
            log.warn(`could not apply localStorage for ${o.origin}`, err);
          } finally {
            await page.close().catch(() => undefined);
          }
        }
        log.info(`${p.name}: imported ${state.cookies.length} cookies and ${origins} origin(s) from the user's computer (replaced ${cleared})`);
        return { cookies: state.cookies.length, origins, cleared };
      },
      { label: `Importing your ${p.name} sign-in`, platform: p.id },
    );
  }

  async status(): Promise<BrowserSnapshot> {
    for (const [platform, page] of this.consolePages) {
      if (page.isClosed()) continue;
      this.titles.set(platform, await page.title().catch(() => this.titles.get(platform) ?? ""));
    }
    return this.snapshot();
  }

  async close() {
    const ctx = this.context;
    if (!ctx) return;
    await this.backupSessions();
    this.context = null;
    this.consolePages.clear();
    this.titles.clear();
    this.activePlatform = null;
    await ctx.close().catch(() => undefined);
    this.announce();
  }
}

/** Ask a plain browser window to close and give it time to flush its profile; force it only if it will not. */
async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid)], { stdio: "ignore" }); // graceful window close
  else child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
  if (graceful) return;
  log.warn("desktop sign-in browser did not close in time; forcing it");
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill("SIGKILL");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
}

/**
 * Is DATA_DIR on a mounted volume? On Linux we read /proc/mounts; anywhere else we
 * cannot tell and return null. A false here means logins vanish on redeploy.
 */
export function storageInfo(): {
  dataDir: string;
  persistent: boolean | null;
  mount: string | null;
  backupAt: string | null;
  /** What keeps state across redeploys. "unknown" when the platform cannot tell (e.g. local dev). */
  persistedBy: "volume" | "database" | "none" | "unknown";
  database: { enabled: boolean; lastSaveAt: string | null; lastError: string | null };
} {
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
  const database = persistStatus();
  const persistedBy = database.enabled && !database.lastError ? "database" : persistent === true ? "volume" : persistent === false ? "none" : "unknown";
  return { dataDir: config.dataDir, persistent, mount, backupAt, persistedBy, database };
}

export const browser = new BrowserManager();

/** Small shared counter so the sync loop can yield while someone is using the VNC screen. */
export const vncState = { connections: 0, lastActivityAt: 0 };
