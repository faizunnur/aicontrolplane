import fs from "node:fs";
import { config } from "./config.js";
import { currentOrgId, getSetting, setSetting, withOrg } from "./db.js";

// Provider configuration is the founding workspace's until the browser fleet phase keys this
// cache per workspace; reads outside any scope (boot, timers) default there too.
const inHomeOrg = <T>(fn: () => T): T => withOrg(currentOrgId() ?? 1, fn);
import { logger } from "./logger.js";
import { base, BUILTIN_DEFAULTS } from "./providers/defaults.js";
import type { PlatformConfig } from "../packages/core/src/index.js";

const log = logger("platforms");

/**
 * Provider configuration store: the built-in defaults (src/providers/defaults.ts) merged with
 * the user's overrides. Overrides live in the database (settings key "platform_overrides");
 * an existing platforms.json is imported once, so older deployments carry over. Reads are
 * served from an in-memory copy so adapters can ask synchronously on hot paths; the copy
 * refreshes on every write here and, for other instances, on a short clock.
 */
export const DEFAULT_PLATFORMS: Record<string, PlatformConfig> = BUILTIN_DEFAULTS;

type Overrides = Record<string, Partial<PlatformConfig>>;

const KEY = "platform_overrides";
const REFRESH_MS = 5_000;

/** One cached override set per workspace: each workspace configures its own providers. */
interface OrgCache {
  overrides: Overrides;
  loadedAt: number;
  loading: Promise<void> | null;
  /** Bumped on every local write; a refresh that started before a write must not clobber it. */
  generation: number;
}
const caches = new Map<number, OrgCache>();
const orgOf = () => currentOrgId() ?? 1;

function entry(org = orgOf()): OrgCache {
  let e = caches.get(org);
  if (!e) {
    e = { overrides: {}, loadedAt: 0, loading: null, generation: 0 };
    caches.set(org, e);
    if (caches.size > 200) {
      // Plain LRU-ish trim: drop the stalest workspace's copy; it reloads on next touch.
      const oldest = [...caches.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0];
      if (oldest && oldest[0] !== org) caches.delete(oldest[0]);
    }
  }
  return e;
}

function parseOverrides(raw: string | undefined | null): Overrides {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Overrides) : {};
  } catch {
    return {};
  }
}

async function loadFromDb(org = orgOf()): Promise<void> {
  const e = entry(org);
  const gen = e.generation;
  let next: Overrides;
  const raw = await withOrg(org, () => getSetting(KEY));
  if (raw !== undefined) {
    next = parseOverrides(raw);
  } else if (org === 1 && fs.existsSync(config.platformsFile)) {
    // One-time import of the legacy file (a founding-workspace artefact), then the database is the source.
    try {
      next = parseOverrides(fs.readFileSync(config.platformsFile, "utf8"));
      await withOrg(1, () => setSetting(KEY, JSON.stringify(next)));
      log.info(`imported platform overrides from ${config.platformsFile} into the database`);
    } catch (err) {
      log.warn("platforms.json unreadable, ignoring", err);
      next = {};
    }
  } else {
    next = {};
  }
  if (gen !== e.generation) return; // a write landed while this read was in flight; it wins
  e.overrides = next;
  e.loadedAt = Date.now();
}

/** Load the overrides before serving. Called at boot; reads before it see only the defaults. */
export async function initPlatforms(): Promise<void> {
  await loadFromDb();
}

/** Force a reload now — for an executor that just missed a platform another process added. */
export async function refreshPlatformsNow(): Promise<void> {
  await loadFromDb();
}

/** Reads stay synchronous; a stale copy quietly refreshes in the background. */
function maybeRefresh(org: number) {
  const e = entry(org);
  if (Date.now() - e.loadedAt < REFRESH_MS || e.loading) return;
  e.loading = loadFromDb(org)
    .catch((err) => log.warn("platform override refresh failed", err))
    .finally(() => (e.loading = null));
}

export function getPlatforms(): Record<string, PlatformConfig> {
  const org = orgOf();
  maybeRefresh(org);
  const cache = entry(org).overrides;
  const out: Record<string, PlatformConfig> = {};
  const ids = new Set([...Object.keys(DEFAULT_PLATFORMS), ...Object.keys(cache)]);
  for (const id of ids) {
    const def = DEFAULT_PLATFORMS[id] ?? base({ id, name: id });
    const o = cache[id] ?? {};
    out[id] = { ...def, ...o, id, actions: { ...(def.actions ?? {}), ...(o.actions ?? {}) } };
  }
  return out;
}

export function getPlatform(id: string): PlatformConfig | undefined {
  return getPlatforms()[id];
}

/** Providers shown in the UI: everything not hidden, built-ins first. */
export function visiblePlatforms(): PlatformConfig[] {
  const order = Object.keys(DEFAULT_PLATFORMS);
  return Object.values(getPlatforms())
    .filter((p) => !p.hidden)
    .sort((a, b) => (order.indexOf(a.id) === -1 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) === -1 ? 99 : order.indexOf(b.id)));
}

export async function savePlatformOverride(id: string, patch: Partial<PlatformConfig>): Promise<PlatformConfig> {
  const e = entry();
  const cleaned: Record<string, unknown> = { ...(e.overrides[id] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    cleaned[k] = v;
  }
  e.overrides = { ...e.overrides, [id]: cleaned as Partial<PlatformConfig> };
  e.generation++;
  e.loadedAt = Date.now();
  await inHomeOrg(() => setSetting(KEY, JSON.stringify(e.overrides)));
  return getPlatform(id)!;
}

export async function deletePlatformOverride(id: string): Promise<void> {
  const e = entry();
  const next = { ...e.overrides };
  delete next[id];
  e.overrides = next;
  e.generation++;
  e.loadedAt = Date.now();
  await inHomeOrg(() => setSetting(KEY, JSON.stringify(e.overrides)));
}

/** Providers that have a tasks page and can therefore be looked at through the browser. */
export function syncablePlatforms(): PlatformConfig[] {
  const all = Object.values(getPlatforms()).filter((p) => p.tasksUrl && !p.hidden);
  if (config.sync.platforms.length) return all.filter((p) => config.sync.platforms.includes(p.id));
  return all;
}

// Lives with the browser flows (no database behind it); kept here for the existing importers.
export { compilePatterns } from "./providers/browser/patterns.js";
