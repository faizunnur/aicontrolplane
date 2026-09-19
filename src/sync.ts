import { browser, vncState } from "./browser/manager.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { syncablePlatforms } from "./platforms.js";
import { syncPlatform, type SyncResult } from "./collect/collector.js";

const log = logger("sync");

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
  } catch (err) {
    log.error("scheduled sync failed", err);
  } finally {
    scheduleNext(config.sync.intervalMin * 60_000);
  }
}

/** Sync every syncable platform, sequentially. Safe to call while the scheduler is armed. */
export async function syncAll(platformIds?: string[]): Promise<Record<string, SyncResult>> {
  if (running) throw new Error("a sync is already running");
  running = true;
  const results: Record<string, SyncResult> = {};
  try {
    let targets = syncablePlatforms();
    if (platformIds?.length) targets = targets.filter((p) => platformIds.includes(p.id));
    for (const p of targets) {
      results[p.id] = await syncPlatform(p);
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
