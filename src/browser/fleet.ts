import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright";
import { bus } from "../bus.js";
import { config } from "../config.js";
import { currentOrgId, withOrg } from "../db.js";
import { logger } from "../logger.js";
import { browserContextsOpen, browserContextWaiters } from "../metrics.js";
import { getPlatform } from "../platforms.js";
import { cookieMatchesDomain, type StoredCookie, type StoredOrigin } from "../providers/browser/domains.js";
import { GPU_ARGS, resolveExecutable, stopChild, type BrowserSnapshot, type BusyTask, type DesktopSignIn } from "./manager.js";
import { loadConnectionState, saveConnectionState, sliceStateForPlatform, type StorageStateLike } from "./session-store.js";

const DESKTOP_SIGNIN_TIMEOUT_MS = Math.max(1, Number(process.env.DESKTOP_SIGNIN_TIMEOUT_MIN) || 10) * 60_000;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const log = logger("fleet");

/*
  The browser fleet (BROWSER_FLEET=ephemeral): one headless Chromium serves every workspace,
  each (workspace, provider) connection living in its own ephemeral BrowserContext seeded
  from that workspace's sealed session blob and sealed back when it goes idle - hibernation
  by default. Cookies can never bleed between workspaces because they never share a context.

  Serialisation is the connection's own promise-chain lock; the process-wide semaphore caps
  open contexts (RAM), with a per-workspace cap so one workspace cannot hog the pool.
  // LEASE SEAM: with several browser workers, a Redis-leased registry decides which worker
  // owns a connection; today one worker owns them all.
*/

const keyOf = (org: number, platform: string) => `${org}:${platform}`;
const ambientOrg = () => currentOrgId() ?? 1;

class FleetConnection {
  page: Page | null = null;
  title = "";
  queue: Promise<unknown> = Promise.resolve();
  busy: BusyTask | null = null;
  lastUsed = Date.now();
  sealing = false;
  constructor(
    readonly org: number,
    readonly platform: string,
    readonly ctx: BrowserContext,
  ) {}
}

export class FleetManager {
  readonly enabled = config.browser.enabled;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private connections = new Map<string, FleetConnection>();
  private waiters: (() => void)[] = [];
  private snapshotSeq = 0;
  private sweeper: NodeJS.Timeout | null = null;

  /* ---------- what the UI sees (always one workspace's view) ---------- */

  isRunning() {
    return this.browser !== null;
  }
  /** The desktop sign-in in progress — visible only to the workspace that owns it. */
  private desktop: { org: number; state: DesktopSignIn; done: ReturnType<typeof deferred<"finished" | "cancelled">>; job: Promise<void> } | null = null;
  get signIn(): DesktopSignIn | null {
    return this.desktop && this.desktop.org === ambientOrg() ? this.desktop.state : null;
  }
  /** Whose workspace the one physical screen belongs to right now. */
  vncOwnerOrg(): number {
    return this.desktop?.org ?? 1;
  }
  get active(): string | null {
    const org = ambientOrg();
    for (const c of this.connections.values()) if (c.org === org && c.busy) return c.platform;
    return null;
  }
  get busy(): BusyTask | null {
    const org = ambientOrg();
    for (const c of this.connections.values()) if (c.org === org && c.busy) return c.busy;
    return null;
  }

  snapshot(): BrowserSnapshot {
    const org = ambientOrg();
    const pages: BrowserSnapshot["pages"] = [];
    for (const c of this.connections.values()) {
      if (c.org !== org || !c.page || c.page.isClosed()) continue;
      pages.push({ platform: c.platform, url: c.page.url(), title: c.title });
    }
    return { enabled: this.enabled, running: this.isRunning(), headless: true, active: this.active, busy: this.busy, pages, signIn: this.signIn, seq: ++this.snapshotSeq };
  }
  private announce() {
    browserContextsOpen.set(this.connections.size);
    browserContextWaiters.set(this.waiters.length);
    bus.emit("browser", this.snapshot());
  }

  canDesktopSignIn(): { ok: boolean; reason?: string } {
    if (!this.enabled) return { ok: false, reason: "the browser is disabled on this deployment" };
    if (config.browser.headless) return { ok: false, reason: "this deployment runs without a display, so there is no desktop to sign in on; import a session from your own computer instead" };
    if (this.desktop && this.desktop.org !== ambientOrg()) return { ok: false, reason: "the shared screen is in use by another workspace; try again in a few minutes" };
    return { ok: true };
  }

  /**
   * A plain Chrome window on the ONE shared display, in a THROW-AWAY profile seeded from
   * this workspace's session for this provider — never a shared profile, so no other
   * workspace's cookies are anywhere near the window. Afterwards the profile is exported,
   * domain-filtered, sealed to the (workspace, provider) blob, and deleted.
   */
  async startDesktopSignIn(platformId: string, name: string, url: string): Promise<DesktopSignIn> {
    const can = this.canDesktopSignIn();
    if (!can.ok) throw Object.assign(new Error(can.reason), { status: 409 });
    const org = ambientOrg();
    if (this.desktop && this.desktop.org === org && this.desktop.state.platform === platformId) return this.desktop.state;
    if (this.desktop) throw Object.assign(new Error(`a sign-in to ${this.desktop.org === org ? this.desktop.state.platform : "another workspace's provider"} is already in progress; finish or cancel it first`), { status: 409 });
    const done = deferred<"finished" | "cancelled">();
    const started = deferred<DesktopSignIn | Error>();
    const job = (async () => {
      const tmpDir = path.join(config.dataDir, "desktop-tmp", `${org}-${platformId}-${Date.now()}`);
      let child: ChildProcess | null = null;
      try {
        // Seed the throw-away profile with this workspace's cookies for the provider.
        fs.mkdirSync(tmpDir, { recursive: true });
        const raw = await withOrg(org, () => loadConnectionState(platformId));
        if (raw) {
          const seedCtx = await chromium.launchPersistentContext(tmpDir, { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"] });
          try {
            const state = JSON.parse(raw) as StorageStateLike;
            const cookies = (state.cookies ?? []).filter((c) => c && c.name && c.domain);
            if (cookies.length) await seedCtx.addCookies(cookies as never);
          } finally {
            await seedCtx.close().catch(() => undefined);
          }
        }
        const exe = resolveExecutable();
        const [w, h] = config.browser.windowSize;
        const args = [
          `--user-data-dir=${tmpDir}`,
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
        log.info(`desktop sign-in for workspace ${org} / ${platformId}: opening ${exe.path} on ${process.env.DISPLAY ?? "the desktop"} (throw-away profile)`);
        child = spawn(exe.path, args, { stdio: "ignore", env: process.env });
        const state: DesktopSignIn = { platform: platformId, url, since: new Date().toISOString(), pid: child.pid ?? null };
        this.desktop = { org, state, done, job: job! };
        this.announce();
        child.on("exit", () => {
          if (this.desktop?.state === state) done.resolve("finished");
        });
        child.on("error", (err) => {
          log.error("desktop sign-in browser failed to start", err);
          started.resolve(err instanceof Error ? err : new Error(String(err)));
          done.resolve("cancelled");
        });
        started.resolve(state);
        const outcome = await Promise.race([done.promise, new Promise<"cancelled">((r) => setTimeout(() => r("cancelled"), DESKTOP_SIGNIN_TIMEOUT_MS).unref?.())]);
        log.info(`desktop sign-in for workspace ${org} / ${platformId} ${outcome}`);
        await stopChild(child, outcome === "finished" ? 10_000 : 4_000);
        if (outcome === "finished") {
          // Export what the person signed in to, keep only this provider's slice, seal it.
          const outCtx = await chromium.launchPersistentContext(tmpDir, { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"] });
          try {
            const state2 = (await outCtx.storageState()) as StorageStateLike;
            const p = withOrg(org, () => getPlatform(platformId));
            const slice = p ? sliceStateForPlatform(state2, p) : state2;
            await withOrg(org, () => saveConnectionState(platformId, JSON.stringify(slice)));
          } finally {
            await outCtx.close().catch(() => undefined);
          }
          // An open automation connection restarts from the fresh blob.
          const conn = this.connections.get(keyOf(org, platformId));
          if (conn) {
            this.connections.delete(keyOf(org, platformId));
            await conn.ctx.close().catch(() => undefined);
            this.releaseSlot();
          }
        }
      } catch (err) {
        started.resolve(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        this.desktop = null;
        this.announce();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    })();
    job.catch((err) => log.error("desktop sign-in failed", err));
    const first = await started.promise;
    if (first instanceof Error) throw first;
    return first;
  }

  async finishDesktopSignIn(): Promise<boolean> {
    const d = this.desktop;
    if (!d || d.org !== ambientOrg()) return false;
    d.done.resolve("finished");
    await d.job.catch(() => undefined);
    return true;
  }
  async cancelDesktopSignIn(): Promise<boolean> {
    const d = this.desktop;
    if (!d || d.org !== ambientOrg()) return false;
    d.done.resolve("cancelled");
    await d.job.catch(() => undefined);
    return true;
  }

  /* ---------- the Chromium process and the context pool ---------- */

  private async host(): Promise<Browser> {
    if (!this.enabled) throw new Error("browser is disabled (BROWSER_ENABLED=false)");
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      log.info(`launching fleet Chromium (max ${config.fleet.maxContexts} contexts, ${config.fleet.orgMaxContexts}/workspace)`);
      const b = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic", "--disable-blink-features=AutomationControlled"],
      });
      b.on("disconnected", () => {
        log.warn("fleet Chromium exited");
        this.browser = null;
        this.connections.clear();
        this.announce();
      });
      this.browser = b;
      if (!this.sweeper) {
        this.sweeper = setInterval(() => void this.sweepIdle().catch(() => undefined), 30_000);
        this.sweeper.unref?.();
      }
      return b;
    })().finally(() => (this.launching = null));
    return this.launching;
  }

  private orgOpen(org: number): number {
    let n = 0;
    for (const c of this.connections.values()) if (c.org === org) n++;
    return n;
  }

  /** Make room for one more context, evicting idle connections (LRU) or waiting for a release. */
  private async acquireSlot(org: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const overGlobal = this.connections.size >= config.fleet.maxContexts;
      const overOrg = this.orgOpen(org) >= config.fleet.orgMaxContexts;
      if (!overGlobal && !overOrg) return;
      const idle = [...this.connections.values()].filter((c) => !c.busy && !c.sealing && (!overOrg || c.org === org)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) {
        await this.seal(idle, "evicted for a busier connection");
        continue;
      }
      if (Date.now() > deadline) throw Object.assign(new Error("every browser slot is busy; try again in a moment"), { status: 429 });
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 2_000).unref?.();
      });
    }
  }
  private releaseSlot() {
    const w = this.waiters.shift();
    if (w) w();
  }

  private async connection(platform: string): Promise<FleetConnection> {
    const org = ambientOrg();
    const key = keyOf(org, platform);
    const existing = this.connections.get(key);
    if (existing) {
      if (existing.ctx.browser()?.isConnected()) {
        existing.lastUsed = Date.now();
        return existing;
      }
      this.connections.delete(key);
    }
    const b = await this.host();
    await this.acquireSlot(org);
    const raw = await withOrg(org, () => loadConnectionState(platform));
    let storageState: StorageStateLike | undefined;
    try {
      storageState = raw ? (JSON.parse(raw) as StorageStateLike) : undefined;
    } catch {
      storageState = undefined;
    }
    const [w, h] = config.browser.windowSize;
    const ctx = await b.newContext({
      viewport: { width: w, height: h },
      locale: "en-US",
      // Playwright's own types want its exact shape; ours is the same JSON.
      storageState: storageState as never,
    });
    const conn = new FleetConnection(org, platform, ctx);
    this.connections.set(key, conn);
    log.info(`opened connection ${key} (${this.connections.size}/${config.fleet.maxContexts} contexts, seeded=${!!storageState})`);
    this.announce();
    return conn;
  }

  /** Export, seal and close a connection. Its session survives; the context's RAM does not. */
  private async seal(conn: FleetConnection, why: string): Promise<void> {
    const key = keyOf(conn.org, conn.platform);
    if (conn.sealing) return;
    conn.sealing = true;
    this.connections.delete(key);
    try {
      const state = await conn.ctx.storageState({ indexedDB: true }).catch(() => conn.ctx.storageState());
      await withOrg(conn.org, () => saveConnectionState(conn.platform, JSON.stringify(state)));
    } catch (err) {
      log.warn(`sealing ${key} failed (${why}); its last saved session stands`, err);
    }
    await conn.ctx.close().catch(() => undefined);
    log.info(`sealed connection ${key} (${why})`);
    this.releaseSlot();
    this.announce();
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - config.fleet.contextIdleMs;
    for (const conn of [...this.connections.values()]) {
      if (!conn.busy && !conn.sealing && conn.lastUsed < cutoff) await this.seal(conn, "idle");
    }
  }

  /* ---------- the public surface the adapters drive ---------- */

  withLock<T>(fn: () => Promise<T>, task?: { label: string; platform?: string | null; messageId?: number | null }): Promise<T> {
    const org = ambientOrg();
    const run = async (): Promise<T> => {
      const conn = task?.platform ? await this.connection(task.platform) : null;
      const chainOn: { queue: Promise<unknown> } = conn ?? this.hostChain;
      const job = async () => {
        const busy: BusyTask = { label: task?.label ?? "Working", platform: task?.platform ?? null, messageId: task?.messageId ?? null, since: new Date().toISOString() };
        if (conn) conn.busy = busy;
        this.announce();
        try {
          return await withOrg(org, fn);
        } finally {
          if (conn) {
            conn.busy = null;
            conn.lastUsed = Date.now();
          }
          this.announce();
        }
      };
      const next = chainOn.queue.then(job, job);
      chainOn.queue = next.catch(() => undefined);
      return next;
    };
    return run();
  }
  private hostChain: { queue: Promise<unknown> } = { queue: Promise.resolve() }; // for the rare platform-less job

  pageOf(platformId: string): Page | undefined {
    const conn = this.connections.get(keyOf(ambientOrg(), platformId));
    return conn?.page && !conn.page.isClosed() ? conn.page : undefined;
  }

  async bringToFront(platformId: string): Promise<boolean> {
    // Headless contexts have no z-order; the live view streams each connection's own page.
    return this.pageOf(platformId) !== undefined;
  }

  async consolePage(platformId: string, url?: string): Promise<Page> {
    const conn = await this.connection(platformId);
    conn.lastUsed = Date.now();
    if (!conn.page || conn.page.isClosed()) {
      conn.page = await conn.ctx.newPage();
      const page = conn.page;
      page.on("load", () => {
        page
          .title()
          .then((t) => {
            conn.title = t;
            this.announce();
          })
          .catch(() => undefined);
      });
      page.on("close", () => {
        if (conn.page === page) conn.page = null;
        this.announce();
      });
      this.announce();
    }
    if (url) {
      try {
        await conn.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
        if (!/Timeout|Target closed|has been closed|crashed/i.test(msg)) throw err;
        log.warn(`navigation to ${url} stalled (${msg}); retrying on a fresh tab`);
        await conn.page.close().catch(() => undefined);
        conn.page = await conn.ctx.newPage();
        await conn.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      }
    }
    return conn.page;
  }

  async resetConsolePage(platformId: string) {
    const conn = this.connections.get(keyOf(ambientOrg(), platformId));
    if (conn?.page && !conn.page.isClosed()) await conn.page.close().catch(() => undefined);
    if (conn) conn.page = null;
  }

  /** The ambient workspace's cookies across its open connections (a login check's view). */
  async cookies(domainIncludes?: string): Promise<Cookie[]> {
    const org = ambientOrg();
    const all: Cookie[] = [];
    for (const conn of this.connections.values()) {
      if (conn.org !== org) continue;
      all.push(...(await conn.ctx.cookies().catch(() => [] as Cookie[])));
    }
    return domainIncludes ? all.filter((c) => c.domain.includes(domainIncludes)) : all;
  }

  async cookieCounts(domains: string[]): Promise<Record<string, number>> {
    const all = await this.cookies();
    const out: Record<string, number> = {};
    for (const d of domains) out[d] = all.filter((c) => c.domain.includes(d)).length;
    return out;
  }

  /** No shared context exists in fleet mode; every caller works through a connection. */
  async getContext(): Promise<BrowserContext> {
    throw Object.assign(new Error("fleet mode has no shared browser context; work through a provider connection"), { status: 409 });
  }

  async importState(_state: { cookies?: Cookie[] }): Promise<number> {
    throw Object.assign(new Error("whole-profile import is a single-workspace feature; connect each provider instead"), { status: 409 });
  }

  /** The ambient workspace's sessions, merged - live connections sealed first so nothing is stale. */
  async exportState(): Promise<{ cookies: Cookie[]; origins: StoredOrigin[] }> {
    const org = ambientOrg();
    for (const conn of [...this.connections.values()]) if (conn.org === org && !conn.busy) await this.seal(conn, "export");
    const { visiblePlatforms } = await import("../platforms.js");
    const cookies: Cookie[] = [];
    const origins: StoredOrigin[] = [];
    for (const p of visiblePlatforms()) {
      const raw = await loadConnectionState(p.id);
      if (!raw) continue;
      try {
        const s = JSON.parse(raw) as StorageStateLike;
        cookies.push(...((s.cookies ?? []) as unknown as Cookie[]));
        origins.push(...((s.origins ?? []) as unknown as StoredOrigin[]));
      } catch {
        /* one bad blob must not end the export */
      }
    }
    return { cookies, origins };
  }

  /**
   * Replace one provider's session with what the user's computer captured: the blob is
   * rewritten and any open connection restarts from it. No other workspace is anywhere near.
   */
  async importProviderState(p: { id: string; name: string }, domains: string[], state: { cookies: StoredCookie[]; origins: StoredOrigin[] }): Promise<{ cookies: number; origins: number; cleared: number }> {
    const org = ambientOrg();
    const existing = this.connections.get(keyOf(org, p.id));
    let cleared = 0;
    if (existing) {
      cleared = (await existing.ctx.cookies().catch(() => [] as Cookie[])).filter((c) => cookieMatchesDomain(c.domain, domains)).length;
      this.connections.delete(keyOf(org, p.id));
      await existing.ctx.close().catch(() => undefined);
      this.releaseSlot();
    } else {
      const raw = await loadConnectionState(p.id);
      if (raw) {
        try {
          cleared = ((JSON.parse(raw) as StorageStateLike).cookies ?? []).length;
        } catch {
          cleared = 0;
        }
      }
    }
    const storage: StorageStateLike = {
      cookies: state.cookies as unknown as StorageStateLike["cookies"],
      origins: state.origins.map((o) => ({ origin: o.origin, localStorage: o.localStorage })),
    };
    await saveConnectionState(p.id, JSON.stringify(storage));
    log.info(`${p.name}: imported ${state.cookies.length} cookies and ${state.origins.length} origin(s) for workspace ${org} (replaced ${cleared})`);
    return { cookies: state.cookies.length, origins: state.origins.length, cleared };
  }

  async backupSessions(): Promise<number> {
    // Seal-in-place for every open connection, whatever its workspace (shutdown path).
    let cookies = 0;
    for (const conn of [...this.connections.values()]) {
      if (conn.busy || conn.sealing) continue;
      try {
        const state = await conn.ctx.storageState();
        cookies += state.cookies.length;
        await withOrg(conn.org, () => saveConnectionState(conn.platform, JSON.stringify(state)));
        conn.lastUsed = Date.now();
      } catch (err) {
        log.warn(`backup of ${keyOf(conn.org, conn.platform)} failed`, err);
      }
    }
    return cookies;
  }

  async status(): Promise<BrowserSnapshot> {
    const org = ambientOrg();
    for (const conn of this.connections.values()) {
      if (conn.org !== org || !conn.page || conn.page.isClosed()) continue;
      conn.title = await conn.page.title().catch(() => conn.title);
    }
    return this.snapshot();
  }

  async close() {
    for (const conn of [...this.connections.values()]) await this.seal(conn, "shutdown");
    const b = this.browser;
    this.browser = null;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await b?.close().catch(() => undefined);
    this.announce();
  }
}
