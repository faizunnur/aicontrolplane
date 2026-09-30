import { browser } from "./browser/manager.js";
import { config } from "./config.js";
import { createBrowserOp, currentOrgId, finishBrowserOp, getBrowserOp } from "./db.js";
import { logger } from "./logger.js";
import { getPlatform, refreshPlatformsNow } from "./platforms.js";
import { requireProvider } from "./providers/registry.js";
import type { StoredCookie, StoredOrigin } from "./providers/browser/domains.js";
import { screenshotProvider } from "./providers/browser/actions.js";

const log = logger("browser-ops");

/*
  Interactive browser work that an api process (which holds no Chrome) needs done NOW, with
  an answer: sign-in checks, connects, session imports, console opens, desktop sign-ins.
  A process that has the browser performs the op directly; one that does not writes an op
  row, enqueues it to the browser queue, and polls the row for the result. Long-running
  fire-and-forget work stays on the ordinary job queues — this is only for the short,
  answer-now calls behind interactive endpoints.
*/

type OpHandler = (payload: never) => Promise<unknown>;

/**
 * Whether the CALLING workspace owns the physical desktop screen. Ops run in the caller's
 * workspace scope — the request's on a browser-holding process, the adopted op row's on a
 * worker — so this is the org the answer is for, not the process's.
 */
const ownsDesktop = () => (currentOrgId() ?? 1) === browser.vncOwnerOrg();

/** Resolve a provider, reading the store once more if this process has not seen it yet. */
async function freshProvider(platformId: string) {
  if (!getPlatform(platformId)) await refreshPlatformsNow();
  return requireProvider(platformId);
}
async function freshPlatform(platformId: string) {
  let p = getPlatform(platformId);
  if (!p) {
    await refreshPlatformsNow();
    p = getPlatform(platformId);
  }
  if (!p) throw new Error(`unknown platform ${platformId}`);
  return p;
}

const OPS = {
  "auth.check": async ({ platformId }: { platformId: string }) => (await freshProvider(platformId)).checkAuth(),
  "auth.connect": async ({ platformId }: { platformId: string }) => (await freshProvider(platformId)).connect(),
  "session.import": async ({ platformId, cookies, origins }: { platformId: string; cookies: StoredCookie[]; origins: StoredOrigin[] }) => {
    const p = await freshPlatform(platformId);
    const { sessionDomains } = await import("./providers/browser/domains.js");
    const imported = await browser.importProviderState(p, sessionDomains(p), { cookies, origins });
    const status = await (await freshProvider(platformId)).checkAuth();
    return { imported, status };
  },
  "console.open": async ({ platformId, url }: { platformId: string; url: string }) => (await freshProvider(platformId)).openConsole(url),
  "action.run": async ({ platformId, action, taskId, vars }: { platformId: string; action: string; taskId?: number | null; vars?: Record<string, string> }) => {
    const { runAction } = await import("./actions.js");
    const { getTask } = await import("./db.js");
    const p = await freshPlatform(platformId);
    const task = taskId ? await getTask(taskId) : undefined;
    return runAction(p, action, task, vars ?? {});
  },
  "screenshot.take": async ({ platformId }: { platformId: string }) => {
    const p = await freshPlatform(platformId);
    return { file: await screenshotProvider(p) };
  },
  "desktop.start": async ({ platformId }: { platformId: string }) => {
    // The desktop is ONE physical screen, and the VNC route shows it only to its owner
    // workspace. Starting a sign-in another workspace could never watch or finish would
    // just park an orphaned window on someone else's desktop.
    if (!ownsDesktop()) throw new BrowserOpError("the cloud desktop belongs to another workspace — sign in in the live view, or connect from this computer", 403);
    const p = await freshPlatform(platformId);
    return browser.startDesktopSignIn(p.id, p.name, p.appUrl);
  },
  // finish/cancel stay open to every workspace: after the start gate only the owner can have
  // a desktop sign-in, and an orphan from before the gate must stay cancellable by whoever
  // sees its buttons.
  "desktop.finish": async ({ platformId }: { platformId: string }) => {
    const wasDesktop = await browser.finishDesktopSignIn();
    const status = await (await freshProvider(platformId)).checkAuth();
    return { wasDesktop, status };
  },
  "desktop.cancel": async (_p: Record<string, never>) => ({ ok: await browser.cancelDesktopSignIn() }),
  "desktop.state": async (_p: Record<string, never>) => ({
    // Another workspace's desktop sign-in is not this one's business — and must not block
    // its pairing flow or paint its UI with a sign-in it cannot see.
    signIn: ownsDesktop() ? (browser.signIn ?? null) : null,
    canDesktop: ownsDesktop() ? browser.canDesktopSignIn() : { ok: false, reason: "the cloud desktop belongs to another workspace" },
    enabled: browser.enabled,
  }),
  "sync.provider": async ({ platformId }: { platformId: string }) => {
    const { syncProvider } = await import("./sync.js");
    return syncProvider(await freshProvider(platformId));
  },
  "sync.all": async ({ platformIds }: { platformIds: string[] | null }) => {
    const { syncAll } = await import("./sync.js");
    return syncAll(platformIds ?? undefined);
  },
} satisfies Record<string, OpHandler>;

export interface DesktopState {
  signIn: { platform: string; name?: string } | null;
  /** Whether the CALLING workspace may sign in on the desktop, with the reason when it cannot. */
  canDesktop: { ok: boolean; reason?: string };
  enabled: boolean;
}

/** Is there a browser somewhere in this deployment? Locally we know; an api process assumes so. */
export function browserRuntimeAvailable(): boolean {
  return hasLocalBrowser() ? browser.enabled : true;
}

/** Per workspace: the answer depends on who asks (only the desktop's owner can use it). */
const desktopCache = new Map<number, { at: number; v: DesktopState }>();
/** The desktop sign-in state, wherever the browser lives — cached briefly, degrading gracefully. */
export async function desktopState(): Promise<DesktopState> {
  if (hasLocalBrowser()) return (await performBrowserOp("desktop.state", {})) as DesktopState;
  const org = currentOrgId() ?? 1;
  const cached = desktopCache.get(org);
  if (cached && Date.now() - cached.at < 5_000) return cached.v;
  try {
    const v = await callBrowserOp<DesktopState>("desktop.state", {}, 10_000);
    desktopCache.set(org, { at: Date.now(), v });
    return v;
  } catch (err) {
    log.debug("desktop state unavailable", err);
    return { signIn: null, canDesktop: { ok: false, reason: "no browser worker answered" }, enabled: true };
  }
}

export type BrowserOpName = keyof typeof OPS;

const hasLocalBrowser = () => config.role === "all" || config.role === "browser";

/** Perform one op on this process. Only browser-holding processes call this. */
export async function performBrowserOp(op: string, payload: unknown): Promise<unknown> {
  const handler = OPS[op as BrowserOpName];
  if (!handler) throw new Error(`unknown browser op "${op}"`);
  return handler(payload as never);
}

export class BrowserOpError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "BrowserOpError";
  }
}

/** Run an op wherever the browser lives and return its answer, or throw BrowserOpError. */
export async function callBrowserOp<T>(op: BrowserOpName, payload: unknown, timeoutMs = 90_000): Promise<T> {
  if (hasLocalBrowser()) return (await performBrowserOp(op, payload)) as T;
  const { JOB, queue } = await import("./queue.js");
  const row = await createBrowserOp(op, payload);
  await queue.send(JOB.browserOp, { opId: row.id }, { singletonKey: `bop:${row.id}`, expireInSeconds: Math.ceil(timeoutMs / 1000) + 30 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const cur = await getBrowserOp(row.id);
    if (!cur) break;
    if (cur.status === "done") return (cur.result ? JSON.parse(cur.result) : undefined) as T;
    if (cur.status === "failed") throw new BrowserOpError(cur.result ? (JSON.parse(cur.result) as { error?: string }).error ?? "browser op failed" : "browser op failed");
  }
  // Close the op before giving up: a worker that picks the job up later must find it settled,
  // not perform a browser action whose caller already reported failure. (Guarded update — if
  // the worker finished in this same instant, its answer stands and this is a no-op.)
  await finishBrowserOp(row.id, "failed", { error: "no browser worker answered in time" });
  throw new BrowserOpError("no browser worker answered in time; is one running?", 504);
}

/** The browser.op job body: perform and write the answer back. */
export async function executeBrowserOpJob(opId: number): Promise<void> {
  const row = await getBrowserOp(opId);
  if (!row || row.status !== "pending") return;
  try {
    const result = await performBrowserOp(row.op, row.payload ? JSON.parse(row.payload) : undefined);
    await finishBrowserOp(opId, "done", result ?? null);
  } catch (err) {
    log.warn(`browser op #${opId} (${row.op}) failed`, err);
    await finishBrowserOp(opId, "failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
