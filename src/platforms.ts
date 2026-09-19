import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { PlatformConfig } from "./types.js";

const log = logger("platforms");

/**
 * Built-in platform definitions. Every field can be overridden per platform in
 * DATA_DIR/platforms.json (editable from the dashboard), and new platforms can
 * be added there with the same shape.
 */
export const DEFAULT_PLATFORMS: Record<string, PlatformConfig> = {
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    appUrl: "https://chatgpt.com/",
    tasksUrl: "https://chatgpt.com/tasks",
    capturePatterns: ["backend-api/.*(task|schedul|automation|recurr)", "/api/.*(task|schedul|automation)"],
    loginUrlPatterns: ["auth\\.openai\\.com", "/auth/login", "/log-in", "chatgpt\\.com/auth"],
    sessionCookie: "__Secure-next-auth.session-token",
    cookieDomain: "chatgpt.com",
    loggedInSelector: "",
    nativeUrlTemplate: "",
    snapshotSelector: "main",
    actions: {
      send_message: {
        label: "Send message",
        description: "Type an instruction into the task's conversation and send it.",
        steps: [
          { type: "goto", url: "{{native_url}}" },
          { type: "waitFor", selector: "#prompt-textarea" },
          { type: "fill", selector: "#prompt-textarea", value: "{{message}}" },
          { type: "wait", ms: 400 },
          { type: "click", selector: 'button[data-testid="send-button"]' },
        ],
      },
    },
    notes: "Scheduled tasks live under Scheduled in the sidebar. Task result emails can also be ingested via IMAP.",
  },
  claude: {
    id: "claude",
    name: "Claude",
    appUrl: "https://claude.ai/",
    tasksUrl: "https://claude.ai/code",
    capturePatterns: ["claude\\.ai/api/.*(routine|schedul|task|session|cowork)"],
    loginUrlPatterns: ["claude\\.ai/login", "/login\\b", "auth\\.anthropic", "accounts\\.anthropic"],
    sessionCookie: "sessionKey",
    cookieDomain: "claude.ai",
    loggedInSelector: "",
    nativeUrlTemplate: "",
    snapshotSelector: "main",
    actions: {
      send_message: {
        label: "Send message",
        description: "Type an instruction into the open Claude conversation and send it.",
        steps: [
          { type: "goto", url: "{{native_url}}" },
          { type: "waitFor", selector: 'div[contenteditable="true"]' },
          { type: "fill", selector: 'div[contenteditable="true"]', value: "{{message}}" },
          { type: "wait", ms: 400 },
          { type: "press", selector: 'div[contenteditable="true"]', key: "Enter" },
        ],
      },
    },
    notes: "Claude Code routines and remote sessions. Cowork desktop tasks report in via the push API or the MCP reporter.",
  },
  grok: {
    id: "grok",
    name: "Grok",
    appUrl: "https://grok.com/",
    tasksUrl: "https://grok.com/",
    capturePatterns: ["grok\\.com/rest/.*(bot|routine|task|schedul|agent)", "grok\\.com/api/.*(bot|routine|task|schedul|agent)"],
    loginUrlPatterns: ["accounts\\.x\\.ai", "/sign-in", "/login\\b"],
    sessionCookie: "sso",
    cookieDomain: "grok.com",
    loggedInSelector: "",
    nativeUrlTemplate: "",
    snapshotSelector: "main",
    actions: {
      send_message: {
        label: "Send message",
        description: "Type an instruction into the Grok composer and send it.",
        steps: [
          { type: "goto", url: "{{native_url}}" },
          { type: "waitFor", selector: "textarea" },
          { type: "fill", selector: "textarea", value: "{{message}}" },
          { type: "wait", ms: 400 },
          { type: "press", selector: "textarea", key: "Enter" },
        ],
      },
    },
    notes: "Grok Bot routines. Point tasksUrl at your bots/routines page.",
  },
  muse: {
    id: "muse",
    name: "Muse",
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
    notes: "Registry-only until you set appUrl/tasksUrl. Agents can also report in via the push API.",
  },
  custom: {
    id: "custom",
    name: "Custom agents",
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
    notes: "Anything you build yourself. Report runs with POST /api/ingest.",
  },
};

type Overrides = Record<string, Partial<PlatformConfig>>;

function readOverrides(): Overrides {
  try {
    if (!fs.existsSync(config.platformsFile)) return {};
    const raw = fs.readFileSync(config.platformsFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Overrides) : {};
  } catch (err) {
    log.warn("platforms.json unreadable, ignoring", err);
    return {};
  }
}

export function getPlatforms(): Record<string, PlatformConfig> {
  const overrides = readOverrides();
  const out: Record<string, PlatformConfig> = {};
  const ids = new Set([...Object.keys(DEFAULT_PLATFORMS), ...Object.keys(overrides)]);
  for (const id of ids) {
    const base: PlatformConfig = DEFAULT_PLATFORMS[id] ?? { ...DEFAULT_PLATFORMS.custom, id, name: id, notes: "" };
    const o = overrides[id] ?? {};
    out[id] = { ...base, ...o, id, actions: { ...(base.actions ?? {}), ...(o.actions ?? {}) } };
  }
  return out;
}

export function getPlatform(id: string): PlatformConfig | undefined {
  return getPlatforms()[id];
}

export function savePlatformOverride(id: string, patch: Partial<PlatformConfig>): PlatformConfig {
  const overrides = readOverrides();
  const cleaned: Record<string, unknown> = { ...(overrides[id] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    cleaned[k] = v;
  }
  overrides[id] = cleaned as Partial<PlatformConfig>;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.platformsFile, JSON.stringify(overrides, null, 2));
  return getPlatform(id)!;
}

export function deletePlatformOverride(id: string) {
  const overrides = readOverrides();
  delete overrides[id];
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.platformsFile, JSON.stringify(overrides, null, 2));
}

/** Platforms that have a tasks page and can therefore be synced through the browser. */
export function syncablePlatforms(): PlatformConfig[] {
  const all = Object.values(getPlatforms()).filter((p) => p.tasksUrl);
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
