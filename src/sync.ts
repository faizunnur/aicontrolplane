import { ensureSystemAgent, ensureTaskAgent } from "./agents.js";
import { sendAlert } from "./alerts.js";
import { browser, vncState } from "./browser/manager.js";
import { config } from "./config.js";
import { addEvent, findTask, finishSyncLog, getPlatformState, recordRun, setPlatformState, startSyncLog, upsertTask } from "./db.js";
import { logger } from "./logger.js";
import { syncablePlatforms } from "./platforms.js";
import { getProvider } from "./providers/registry.js";
import type { ExecutionContext, ProviderAdapter } from "./providers/types.js";
import { beginRun, endRun } from "./runs.js";
import type { SessionStatus } from "./types.js";

const log = logger("sync");

export interface SyncResult {
  platform: string;
  ok: boolean;
  sessionStatus: SessionStatus;
  finalUrl?: string;
  agents: number;
  runs: number;
  captures: number;
  discovered: number;
  message?: string;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let nextAt: number | null = null;
let lastResults: Record<string, SyncResult> = {};
let lastRunAt: string | null = null;

export function schedulerStatus() {
  return {
    enabled: config.sync.enabled && browser.enabled,
    running,
    intervalMin: config.sync.intervalMin,
    nextAt: nextAt ? new Date(nextAt).toISOString() : null,
    lastRunAt,
    lastResults,
    vncConnections: vncState.connections,
  };
}

export function startScheduler() {
  if (!config.sync.enabled || !browser.enabled) {
    log.info("scheduler disabled");
    return;
  }
  scheduleNext(config.sync.initialDelayMs);
  log.info(`scheduler armed: every ${config.sync.intervalMin} min, first run in ${Math.round(config.sync.initialDelayMs / 1000)}s`);
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = null;
}

function scheduleNext(ms: number) {
  if (timer) clearTimeout(timer);
  const jitter = ms * 0.15 * (Math.random() * 2 - 1);
  const delay = Math.max(5_000, ms + jitter);
  nextAt = Date.now() + delay;
  timer = setTimeout(tick, delay);
  timer.unref?.();
}

async function tick() {
  try {
    if (vncState.connections > 0 || Date.now() - vncState.lastActivityAt < 60_000) {
      log.info("skipping scheduled sync: browser screen is in use");
    } else {
      await syncAll();
    }
    // Even when nothing synced, keep the session backup fresh (e.g. after a manual login on the screen).
    if (browser.isRunning()) await browser.backupSessions();
  } catch (err) {
    log.error("scheduled sync failed", err);
  } finally {
    scheduleNext(config.sync.intervalMin * 60_000);
  }
}

/**
 * Ask a provider for its tasks and fold the answer into the registry: tasks, runs, session
 * state, events and alerts. The provider only reports what it saw; this is where it becomes state.
 */
export async function syncProvider(adapter: ProviderAdapter, ctx: ExecutionContext = {}): Promise<SyncResult> {
  const p = adapter.config();
  const logId = startSyncLog(p.id);
  const before = getPlatformState(p.id);
  // A look at a provider's tasks is work like any other: it gets a run and a timeline.
  const own = !ctx.runId;
  const scope = own ? beginRun({ kind: "sync", label: `Looking at ${p.name}'s tasks`, provider: p.id, trigger: ctx.trigger ?? "schedule", agent_id: ensureSystemAgent().id }) : null;
  const exec: ExecutionContext = own ? { ...ctx, runId: scope!.run.id, track: scope!.track } : ctx;
  let result: SyncResult;
  try {
    const r = await adapter.listTasks(exec);
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    let agents = 0;
    let runs = 0;
    if (r.sessionStatus === "logged_in") {
      for (const t of r.tasks) {
        const task = upsertTask({ platform: p.id, key: t.key, name: t.name, source: "discovered", schedule: t.schedule, next_run: t.next_run ?? null, status: t.status, native_url: t.native_url, purpose: t.purpose, prompt: t.purpose, meta: { raw: t.raw, discovered_at: new Date().toISOString() } });
        ensureTaskAgent(task);
        agents++;
      }
      for (const run of r.runs) {
        const task = findTask(p.id, run.taskKey);
        if (!task) continue;
        const { created } = recordRun({ task_id: task.id, kind: "discovered", provider: p.id, trigger: "schedule", external_id: run.external_id, status: run.status, started_at: run.started_at, finished_at: run.finished_at, summary: run.summary, output_url: run.output_url, source: "collector", raw: run.raw });
        runs++;
        if (created && (run.status === "failed" || run.status === "needs_attention")) {
          addEvent({ platform: p.id, kind: "run", title: `${task.name}: ${run.status.replace("_", " ")}`, body: run.summary, link: run.output_url ?? task.native_url, dedupe_key: `run:${task.id}:${run.external_id}` });
          void sendAlert({ key: `run:${task.id}`, title: `${p.name} · ${task.name} ${run.status}`, body: run.summary ?? undefined, link: run.output_url ?? undefined });
        }
      }
      // A logged-in session is worth keeping: snapshot cookies to the volume.
      void browser.backupSessions();
    }
    setPlatformState(p.id, {
      screenshot_path: typeof meta.screenshotPath === "string" ? meta.screenshotPath : before.screenshot_path,
      meta: JSON.stringify({ finalUrl: meta.finalUrl, title: meta.title, discovered: meta.discovered, snapshot: meta.snapshot, snapshotAt: new Date().toISOString() }),
    });
    result = { platform: p.id, ok: r.ok, sessionStatus: r.sessionStatus, finalUrl: typeof meta.finalUrl === "string" ? meta.finalUrl : undefined, agents, runs, captures: Number(meta.captures ?? 0), discovered: Array.isArray(meta.discovered) ? meta.discovered.length : 0, message: r.message };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0].slice(0, 500) : String(err);
    log.error(`sync ${p.id} failed: ${message}`);
    exec.track?.failRunning(message);
    result = { platform: p.id, ok: false, sessionStatus: "error", agents: 0, runs: 0, captures: 0, discovered: 0, message };
  }
  if (scope) {
    endRun(scope.run.id, {
      status: !result.ok ? "failed" : result.sessionStatus === "needs_login" ? "needs_attention" : "success",
      summary: result.message ?? null,
      error: result.ok ? null : (result.message ?? "sync failed"),
      output_url: result.finalUrl ?? null,
    });
  }

  const ts = new Date().toISOString();
  setPlatformState(p.id, {
    session_status: result.sessionStatus,
    last_sync_at: ts,
    last_ok_at: result.ok ? ts : before.last_ok_at,
    last_error: result.ok ? null : (result.message ?? "sync failed"),
  });
  finishSyncLog(logId, { ok: result.ok, message: result.message, agents: result.agents, runs: result.runs, captures: result.captures });

  if (result.sessionStatus === "needs_login" && before.session_status !== "needs_login") {
    addEvent({ platform: p.id, kind: "session", title: `${p.name}: login required`, body: `The browser session for ${p.name} is no longer authenticated. Sign in again from the sidebar.`, dedupe_key: `session:${p.id}:${ts.slice(0, 10)}` });
    void sendAlert({ key: `session:${p.id}`, title: `${p.name} needs login`, body: "Open the control plane and sign in again." });
  }
  if (!result.ok && result.sessionStatus === "error" && before.session_status !== "error") {
    addEvent({ platform: p.id, kind: "sync_error", title: `${p.name}: sync error`, body: result.message ?? null, dedupe_key: `sync_error:${p.id}:${ts.slice(0, 13)}` });
    void sendAlert({ key: `sync_error:${p.id}`, title: `${p.name} sync error`, body: result.message });
  }
  return result;
}

/** Sync every provider with a tasks page, sequentially. Safe to call while the scheduler is armed. */
export async function syncAll(platformIds?: string[]): Promise<Record<string, SyncResult>> {
  if (running) throw new Error("a sync is already running");
  running = true;
  const results: Record<string, SyncResult> = {};
  try {
    let targets = syncablePlatforms();
    if (platformIds?.length) targets = targets.filter((p) => platformIds.includes(p.id));
    for (const p of targets) {
      const adapter = getProvider(p.id);
      if (!adapter || !adapter.supports("listTasks")) continue;
      results[p.id] = await syncProvider(adapter);
    }
    lastResults = { ...lastResults, ...results };
    lastRunAt = new Date().toISOString();
    return results;
  } finally {
    running = false;
  }
}

export function isSyncRunning() {
  return running;
}
