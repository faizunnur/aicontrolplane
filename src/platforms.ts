import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { base, BUILTIN_DEFAULTS } from "./providers/defaults.js";
import type { PlatformConfig } from "./types.js";

const log = logger("platforms");

/**
 * Provider configuration store: the built-in defaults (src/providers/defaults.ts) merged with
 * the user's overrides in DATA_DIR/platforms.json, where new providers can be added with the
 * same shape. Behaviour lives in the provider adapters; this module only holds the data.
 */
export const DEFAULT_PLATFORMS: Record<string, PlatformConfig> = BUILTIN_DEFAULTS;

type Overrides = Record<string, Partial<PlatformConfig>>;

function readOverrides(): Overrides {
  try {
    if (!fs.existsSync(config.platformsFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(config.platformsFile, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Overrides) : {};
  } catch (err) {
    log.warn("platforms.json unreadable, ignoring", err);
    return {};
  }
}

function writeOverrides(o: Overrides) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.platformsFile, JSON.stringify(o, null, 2));
}

export function getPlatforms(): Record<string, PlatformConfig> {
  const overrides = readOverrides();
  const out: Record<string, PlatformConfig> = {};
  const ids = new Set([...Object.keys(DEFAULT_PLATFORMS), ...Object.keys(overrides)]);
  for (const id of ids) {
    const def = DEFAULT_PLATFORMS[id] ?? base({ id, name: id });
    const o = overrides[id] ?? {};
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

export function savePlatformOverride(id: string, patch: Partial<PlatformConfig>): PlatformConfig {
  const overrides = readOverrides();
  const cleaned: Record<string, unknown> = { ...(overrides[id] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    cleaned[k] = v;
  }
  overrides[id] = cleaned as Partial<PlatformConfig>;
  writeOverrides(overrides);
  return getPlatform(id)!;
}

export function deletePlatformOverride(id: string) {
  const overrides = readOverrides();
  delete overrides[id];
  writeOverrides(overrides);
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
