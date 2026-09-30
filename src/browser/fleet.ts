import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright";
import { bus } from "../bus.js";
import { config } from "../config.js";
import { claimProvider, currentOrgId, releaseProviderClaim, renewProviderClaim, withOrg } from "../db.js";
import { logger } from "../logger.js";
import { browserContextsOpen, browserContextWaiters } from "../metrics.js";
import { getPlatform } from "../platforms.js";
import { cookieMatchesDomain, type StoredCookie, type StoredOrigin } from "../providers/browser/domains.js";
import { GPU_ARGS, launchWithSandboxFallback, resolveExecutable, sandboxArgs, SNAPSHOT_EPOCH, stopChild, type BrowserSnapshot, type BusyTask, type DesktopSignIn } from "./manager.js";
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

/*
  The cross-worker session claim. The chains map serialises jobs INSIDE one process; with
  several browser workers, the provider_claims row is what stops two of them driving one
  workspace's logged-in account at once and clobbering each other's session blobs. A claim
  is taken before a job touches the connection, renewed on a timer while the connection is
  open, and released when the connection seals or closes. With one worker the claim always
  succeeds (it is ours or free) — one upsert per job.
*/
const CLAIM_TTL_MS = 5 * 60_000;
const CLAIM_RENEW_MS = 60_000;
const claimOwner = `${hostname()}#${process.pid}`;

/** Another worker holds this (workspace, provider) session. Deliver handlers rethrow it so the job retries per policy. */
export class ProviderBusyError extends Error {
  readonly code = "PROVIDER_BUSY";
  constructor(platform: string) {
    super(`${platform} is busy on another worker right now — it will be retried`);
    this.name = "ProviderBusyError";
  }
}
/**
 * The ambient workspace. No scope means no browser: a silent default here would hand one
 * workspace's browser view to another, so it fails closed exactly like the data layer —
 * with the same unit-test escape hatch (node:test callbacks run outside any async scope).
 */
const ambientOrg = () => {
  const org = currentOrgId();
  if (org !== undefined) return org;
  const t = process.env.ACP_TEST_DEFAULT_ORG;
  if (t) return Number(t);
  throw new Error("browser call outside a workspace scope (wrap the caller in withOrg)");
};

class FleetConnection {
  page: Page | null = null;
  title = "";
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
    return { enabled: this.enabled, running: this.isRunning(), headless: config.browser.headless, active: this.active, busy: this.busy, pages, signIn: this.signIn, seq: ++this.snapshotSeq, epoch: SNAPSHOT_EPOCH };
  }
  private announce() {
    browserContextsOpen.set(this.connections.size);
    browserContextWaiters.set(this.waiters.length);
    // The bus payload doubles as the split-mode mirror, a founding-workspace concern until the
    // relay carries orgs (src/browser/live.ts); unscoped paths (sweeper, shutdown) emit that
    // view explicitly rather than borrowing whatever scope happens to be ambient.
    const snap = currentOrgId() !== undefined ? this.snapshot() : withOrg(1, () => this.snapshot());
    bus.emit("browser", snap);
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
      let ownedScreen = false; // the one shared display changed hands and must be handed back
      try {
        // Seed the throw-away profile with this workspace's cookies for the provider.
        fs.mkdirSync(tmpDir, { recursive: true });
        const raw = await withOrg(org, () => loadConnectionState(platformId));
        if (raw) {
          const seedCtx = await launchWithSandboxFallback((sandbox) => chromium.launchPersistentContext(tmpDir, { headless: true, args: [...sandbox, "--disable-dev-shm-usage", "--password-store=basic"] }));
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
          ...sandboxArgs(),
          ...(process.platform === "linux" ? ["--disable-dev-shm-usage", ...GPU_ARGS] : []),
          url,
        ];
        log.info(`desktop sign-in for workspace ${org} / ${platformId}: opening ${exe.path} on ${process.env.DISPLAY ?? "the desktop"} (throw-away profile)`);
        child = spawn(exe.path, args, { stdio: "ignore", env: process.env });
        const state: DesktopSignIn = { platform: platformId, url, since: new Date().toISOString(), pid: child.pid ?? null };
        this.desktop = { org, state, done, job: job! };
        ownedScreen = true;
        // The screen changed hands: established VNC viewer sockets of the previous owner must
        // not watch this workspace type a password. The server tears them down on this signal.
        bus.emit("vnc-owner", { org });
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
          const outCtx = await launchWithSandboxFallback((sandbox) => chromium.launchPersistentContext(tmpDir, { headless: true, args: [...sandbox, "--disable-dev-shm-usage", "--password-store=basic"] }));
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
            await this.releaseClaim(org, platformId);
            this.releaseSlot();
          }
        }
      } catch (err) {
        started.resolve(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        this.desktop = null;
        // Ownership reverts to the founding workspace; whoever just watched must go too.
        if (ownedScreen) bus.emit("vnc-owner", { org: 1 });
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
      // Every workspace's pages render in this one process tree: the renderer sandbox is the
      // wall between a compromised page and the other tenants' cookies. Never drop it lightly.
      // The same fingerprint the legacy browser presents, or Cloudflare (ChatGPT, Grok, Claude)
      // walls every page: the installed Chrome, not the bundled headless shell (whose user agent
      // says "HeadlessChrome"); a real window on the virtual display unless HEADLESS=true; no
      // --enable-automation (it sets navigator.webdriver); software WebGL.
      const exe = resolveExecutable();
      const [w, h] = config.browser.windowSize;
      log.info(`fleet browser: headless=${config.browser.headless}, ${exe.source}: ${exe.path}`);
      const b = await launchWithSandboxFallback((sandbox) =>
        chromium.launch({
          headless: config.browser.headless,
          ...(exe.source === "bundled" ? {} : { executablePath: exe.path }),
          args: [
            ...sandbox,
            "--disable-dev-shm-usage",
            "--password-store=basic",
            "--disable-blink-features=AutomationControlled",
            `--window-size=${w},${h}`,
            "--window-position=0,0",
            "--no-first-run",
            "--no-default-browser-check",
            ...GPU_ARGS,
          ],
          ignoreDefaultArgs: ["--enable-automation"],
        }),
      );
      b.on("disconnected", () => {
        log.warn("fleet Chromium exited");
        this.browser = null;
        this.connections.clear();
        // Nothing to renew for: the claims themselves lapse on their TTL.
        for (const key of [...this.claimRenewers.keys()]) this.stopClaimRenewal(key);
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
        // The timeout path must take its waiter with it, or the dead entry eats a real
        // release later and a genuine waiter sleeps its whole 2s for nothing.
        const wake = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        };
        this.waiters.push(wake);
        setTimeout(wake, 2_000).unref?.();
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

  /* ---------- the cross-worker session claim (see the note above ProviderBusyError) ---------- */

  private claimRenewers = new Map<string, NodeJS.Timeout>();

  /** Take (or keep) the claim for this job, and keep it renewed while the connection stays open. */
  private async acquireClaim(org: number, platform: string): Promise<void> {
    const ok = await withOrg(org, () => claimProvider(platform, claimOwner, CLAIM_TTL_MS));
    if (!ok) throw new ProviderBusyError(platform);
    const key = keyOf(org, platform);
    if (this.claimRenewers.has(key)) return;
    const timer = setInterval(() => {
      void withOrg(org, () => renewProviderClaim(platform, claimOwner, CLAIM_TTL_MS))
        .then((held) => {
          if (!held) {
            // Only possible after the TTL lapsed (a long stall); the next job re-takes it.
            log.warn(`the ${key} session claim lapsed and moved on; stopping its renewal`);
            this.stopClaimRenewal(key);
          }
        })
        .catch(() => undefined);
    }, CLAIM_RENEW_MS);
    timer.unref?.();
    this.claimRenewers.set(key, timer);
  }

  private stopClaimRenewal(key: string): void {
    const timer = this.claimRenewers.get(key);
    if (timer) clearInterval(timer);
    this.claimRenewers.delete(key);
  }

  /** Give the claim back — when the connection it protected is gone. */
  private async releaseClaim(org: number, platform: string): Promise<void> {
    this.stopClaimRenewal(keyOf(org, platform));
    await withOrg(org, () => releaseProviderClaim(platform, claimOwner)).catch(() => undefined);
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
    await this.releaseClaim(conn.org, conn.platform);
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

  /*
    One job at a time per (workspace, provider). The chain is keyed in a map that OUTLIVES
    connection objects: a connection can be sealed or evicted while jobs still queue behind
    it, and a chain hanging off the dead object would let the next caller open a fresh
    connection and drive two pages at once. Each queued job re-resolves the live connection
    when its turn comes, so it always works in the context that actually exists then.
  */
  withLock<T>(fn: () => Promise<T>, task?: { label: string; platform?: string | null; messageId?: number | null }): Promise<T> {
    const org = ambientOrg();
    const platform = task?.platform ?? null;
    const key = platform ? keyOf(org, platform) : "#host"; // the rare platform-less job; never collides with `${org}:${platform}`
    const job = async (): Promise<T> => {
      // The cross-worker claim comes BEFORE the context: held elsewhere, this throws the
      // retryable busy error without opening anything.
      if (platform) await this.acquireClaim(org, platform);
      const conn = platform ? await withOrg(org, () => this.connection(platform)) : null;
      const busy: BusyTask = { label: task?.label ?? "Working", platform, messageId: task?.messageId ?? null, since: new Date().toISOString() };
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
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail: Promise<unknown> = next
      .catch(() => undefined)
      .finally(() => {
        // The map only holds live tails; a settled chain no one queued behind is garbage.
        if (this.chains.get(key) === tail) this.chains.delete(key);
      });
    this.chains.set(key, tail);
    return next;
  }
  private chains = new Map<string, Promise<unknown>>(); // per-(workspace, provider) serialisation, surviving evictions

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
      await this.releaseClaim(org, p.id);
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
    // Busy ones included: storageState() is safe on a live context, and the busiest session
    // is exactly the one whose newest cookies a crash would otherwise lose.
    let cookies = 0;
    for (const conn of [...this.connections.values()]) {
      if (conn.sealing) continue;
      try {
        const state = await conn.ctx.storageState();
        cookies += state.cookies.length;
        await withOrg(conn.org, () => saveConnectionState(conn.platform, JSON.stringify(state)));
        if (!conn.busy) conn.lastUsed = Date.now();
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
