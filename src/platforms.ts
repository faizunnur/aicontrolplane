import fs from "node:fs";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";
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

let cache: Overrides = {};
let loadedAt = 0;
let loading: Promise<void> | null = null;
/** Bumped on every local write; a refresh that started before a write must not clobber it. */
let generation = 0;

function parseOverrides(raw: string | undefined | null): Overrides {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Overrides) : {};
  } catch {
    return {};
  }
}

async function loadFromDb(): Promise<void> {
  const gen = generation;
  let next: Overrides;
  const raw = await getSetting(KEY);
  if (raw !== undefined) {
    next = parseOverrides(raw);
  } else if (fs.existsSync(config.platformsFile)) {
    // One-time import of the legacy file, then the database is the source.
    try {
      next = parseOverrides(fs.readFileSync(config.platformsFile, "utf8"));
      await setSetting(KEY, JSON.stringify(next));
      log.info(`imported platform overrides from ${config.platformsFile} into the database`);
    } catch (err) {
      log.warn("platforms.json unreadable, ignoring", err);
      next = {};
    }
  } else {
    next = {};
  }
  if (gen !== generation) return; // a write landed while this read was in flight; it wins
  cache = next;
  loadedAt = Date.now();
}

/** Load the overrides before serving. Called at boot; reads before it see only the defaults. */
export async function initPlatforms(): Promise<void> {
  await loadFromDb();
}

/** Reads stay synchronous; a stale copy quietly refreshes in the background. */
function maybeRefresh() {
  if (Date.now() - loadedAt < REFRESH_MS || loading) return;
  loading = loadFromDb()
    .catch((err) => log.warn("platform override refresh failed", err))
    .finally(() => (loading = null));
}

export function getPlatforms(): Record<string, PlatformConfig> {
  maybeRefresh();
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
  const cleaned: Record<string, unknown> = { ...(cache[id] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    cleaned[k] = v;
  }
  cache = { ...cache, [id]: cleaned as Partial<PlatformConfig> };
  generation++;
  loadedAt = Date.now();
  await setSetting(KEY, JSON.stringify(cache));
  return getPlatform(id)!;
}

export async function deletePlatformOverride(id: string): Promise<void> {
  const next = { ...cache };
  delete next[id];
  cache = next;
  generation++;
  loadedAt = Date.now();
  await setSetting(KEY, JSON.stringify(cache));
}

/** Providers that have a tasks page and can therefore be looked at through the browser. */
export function syncablePlatforms(): PlatformConfig[] {
  const all = Object.values(getPlatforms()).filter((p) => p.tasksUrl && !p.hidden);
  if (config.sync.platforms.length) return all.filter((p) => config.sync.platforms.includes(p.id));
  return all;
}

export function compilePatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources ?? []) {
    try {
      out.push(new RegExp(s, "i"));
    } catch {
      log.warn(`invalid pattern ignored: ${s}`);
    }
  }
  return out;
}
