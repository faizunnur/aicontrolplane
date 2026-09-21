import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { PlatformConfig } from "./types.js";

const log = logger("platforms");

const base = (p: Partial<PlatformConfig> & { id: string; name: string }): PlatformConfig => ({
  appUrl: "",
  tasksUrl: "",
  capturePatterns: [],
  loginUrlPatterns: [],
  sessionCookie: "",
  cookieDomain: "",
  loggedInSelector: "",
  nativeUrlTemplate: "",
  snapshotSelector: "main",
  actions: {},
  notes: "",
  purpose: "",
  chatUrl: "",
  composerSelector: "",
  sendSelector: "",
  replySelector: "",
  busySelector: "",
  hidden: false,
  ...p,
});

/**
 * Built-in AIs. Every field can be overridden per platform in DATA_DIR/platforms.json
 * (edited from Settings), and new AIs can be added there with the same shape.
 * Selectors are best current knowledge of each web app and are meant to be tuned.
 */
export const DEFAULT_PLATFORMS: Record<string, PlatformConfig> = {
  chatgpt: base({
    id: "chatgpt",
    name: "ChatGPT",
    appUrl: "https://chatgpt.com/",
    chatUrl: "https://chatgpt.com/",
    tasksUrl: "https://chatgpt.com/tasks",
    purpose: "General assistant: research, writing, and scheduled tasks that run on their own.",
    capturePatterns: ["backend-api/.*(task|schedul|automation|recurr)", "/api/.*(task|schedul|automation)"],
    loginUrlPatterns: ["auth\\.openai\\.com", "/auth/login", "/log-in", "chatgpt\\.com/auth"],
    sessionCookie: "__Secure-next-auth.session-token",
    cookieDomain: "chatgpt.com",
    composerSelector: "#prompt-textarea",
    sendSelector: 'button[data-testid="send-button"]',
    replySelector: '[data-message-author-role="assistant"]',
    busySelector: 'button[data-testid="stop-button"]',
    notes: "Scheduled tasks live under Scheduled in the sidebar.",
  }),
  claude: base({
    id: "claude",
    name: "Claude",
    appUrl: "https://claude.ai/",
    chatUrl: "https://claude.ai/new",
    tasksUrl: "https://claude.ai/code",
    purpose: "Coding, documents and analysis; Claude Code routines and Cowork.",
    capturePatterns: ["claude\\.ai/api/.*(routine|schedul|task|session|cowork)"],
    loginUrlPatterns: ["claude\\.ai/login", "/login\\b", "auth\\.anthropic", "accounts\\.anthropic"],
    sessionCookie: "sessionKey",
    cookieDomain: "claude.ai",
    composerSelector: 'div[contenteditable="true"]',
    sendSelector: 'button[aria-label="Send message"]',
    replySelector: '[data-testid="assistant-message"], .font-claude-message, .font-claude-response',
    busySelector: 'button[aria-label="Stop response"]',
    notes: "Claude Code routines and remote sessions.",
  }),
  grok: base({
    id: "grok",
    name: "Grok",
    appUrl: "https://grok.com/",
    chatUrl: "https://grok.com/",
    tasksUrl: "https://grok.com/",
    purpose: "News, X/Twitter trends and quick answers; Grok bots and routines.",
    capturePatterns: ["grok\\.com/rest/.*(bot|routine|task|schedul|agent)", "grok\\.com/api/.*(bot|routine|task|schedul|agent)"],
    loginUrlPatterns: ["accounts\\.x\\.ai", "/sign-in", "/login\\b"],
    sessionCookie: "sso",
    cookieDomain: "grok.com",
    composerSelector: "textarea",
    sendSelector: "",
    replySelector: '[class*="response"], [class*="assistant"], main .prose',
    busySelector: 'button[aria-label="Stop"]',
    notes: "Grok bots and routines.",
  }),
  custom: base({
    id: "custom",
    name: "My agents",
    purpose: "Agents you build yourself that report in through the API.",
    notes: "Anything you build yourself. Report runs with POST /api/ingest.",
    hidden: true,
  }),
};

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

/** AIs shown on Connect: everything not hidden, built-ins first. */
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

/** Platforms that have a tasks page and can therefore be synced through the browser. */
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
