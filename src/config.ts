import path from "node:path";
import { randomBytes } from "node:crypto";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : def;
}
function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const isProd = process.env.NODE_ENV === "production";

/**
 * The address this deployment is reachable at, written the way a browser would show it. A bare
 * domain is accepted (PUBLIC_URL=my-app.up.railway.app) and becomes https://, because that is the
 * shape people paste, and the connect command must carry an address their computer can reach.
 */
export function normalizePublicUrl(raw: string | undefined | null): string {
  const s = String(raw ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}
/** Railway names the service's own domain; it saves setting PUBLIC_URL by hand. */
const fromEnv = normalizePublicUrl(process.env.PUBLIC_URL);
const fromHost = normalizePublicUrl(process.env.RAILWAY_PUBLIC_DOMAIN);

/**
 * Where state lives. A Railway volume announces its mount path; when one exists it always wins,
 * so the volume can be mounted anywhere and a leftover DATA_DIR can't point the app elsewhere.
 */
function resolveDataDir(): string {
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const configured = process.env.DATA_DIR;
  if (volume) {
    if (configured && path.resolve(configured) !== path.resolve(volume)) {
      console.warn(`[config] DATA_DIR=${configured} ignored: using the Railway volume at ${volume}`);
    }
    return path.resolve(volume);
  }
  return path.resolve(configured || (isProd ? "/data" : "./data"));
}
const dataDir = resolveDataDir();

// Passwords and tokens: ACP_ADMIN_TOKEN / ACP_INGEST_TOKEN when set, otherwise created on first
// visit and stored in the database (see auth.ts). Nothing is generated here anymore.
const adminToken = process.env.ACP_ADMIN_TOKEN || "";
const ingestToken = process.env.ACP_INGEST_TOKEN || "";
void randomBytes;

/**
 * Which engine holds the rows. DATABASE_URL selects Postgres (the source of truth for any
 * deployment with more than one process); without it, the local SQLite file serves the
 * single-container mode. DB_DRIVER=sqlite forces the file even when a URL is present
 * (PERSIST_DATABASE_URL then still enables the legacy whole-file mirror).
 */
function dbConfig() {
  const url = process.env.DATABASE_URL || "";
  const forced = (process.env.DB_DRIVER || "").toLowerCase();
  const driver: "sqlite" | "pg" = forced === "sqlite" ? "sqlite" : forced === "pg" ? "pg" : url ? "pg" : "sqlite";
  if (driver === "pg" && !url) console.warn("[config] DB_DRIVER=pg but DATABASE_URL is not set");
  return { driver, url };
}

/**
 * What this process is. "all" (the default) runs everything in one process — the
 * single-container mode. "api" serves HTTP only and enqueues work; "worker" executes jobs,
 * schedulers and pollers; "browser" is reserved for the browser fleet split. Split roles
 * need Postgres (the queue lives there).
 */
function roleConfig(): "all" | "api" | "worker" | "browser" {
  const r = (process.env.ROLE || "all").toLowerCase();
  if (r === "api" || r === "worker" || r === "browser" || r === "all") return r;
  console.warn(`[config] ROLE "${r}" is not all | api | worker | browser; using all`);
  return "all";
}

export const config = {
  isProd,
  port: num(process.env.PORT, 8080),
  dataDir,
  role: roleConfig(),
  redisUrl: process.env.REDIS_URL || "",
  db: dbConfig(),
  dbPath: path.join(dataDir, "acp.sqlite"),
  profileDir: path.join(dataDir, "profile"),
  screenshotDir: path.join(dataDir, "screenshots"),
  platformsFile: path.join(dataDir, "platforms.json"),
  adminToken,
  ingestToken,
  publicUrl: fromEnv || fromHost,
  /**
   * Where that address came from, so the UI can say so and nudge when it is missing. It is never
   * learned from request headers anymore (a spoofed Host on the first request could poison every
   * alert, webhook and pairing command); "none" means only per-request fallbacks apply.
   */
  publicUrlSource: (fromEnv ? "env" : fromHost ? "host" : "none") as "env" | "host" | "none",

  /**
   * How Chrome serves workspaces. "legacy": one persistent profile, one workspace — exactly
   * the single-container behaviour. "ephemeral": one headless Chromium, one ephemeral context
   * per (workspace, provider) seeded from its sealed session blob — the multi-workspace fleet.
   */
  fleet: {
    mode: (process.env.BROWSER_FLEET === "ephemeral" ? "ephemeral" : "legacy") as "legacy" | "ephemeral",
    maxContexts: num(process.env.BROWSER_MAX_CONTEXTS, 4),
    orgMaxContexts: num(process.env.BROWSER_ORG_MAX_CONTEXTS, 2),
    contextIdleMs: num(process.env.BROWSER_CONTEXT_IDLE_MS, 5 * 60_000),
  },

  browser: {
    enabled: bool(process.env.BROWSER_ENABLED, true),
    headless: bool(process.env.HEADLESS, false),
    channel: process.env.BROWSER_CHANNEL || undefined,
    windowSize: (process.env.SCREEN_GEOMETRY || "1280x800x24").split("x").slice(0, 2).map(Number) as [number, number],
  },

  sync: {
    enabled: bool(process.env.SYNC_ENABLED, true),
    intervalMin: num(process.env.SYNC_INTERVAL_MIN, 20),
    settleMs: num(process.env.SYNC_SETTLE_MS, 4000),
    platforms: list(process.env.SYNC_PLATFORMS),
    initialDelayMs: num(process.env.SYNC_INITIAL_DELAY_MS, 30_000),
  },

  vnc: {
    target: process.env.VNC_TARGET || "http://127.0.0.1:6080",
  },

  alerts: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || "",
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    cooldownMin: num(process.env.ALERT_COOLDOWN_MIN, 360),
  },

  router: routerConfig(),

  /** Outbound mail (sign-up verification, password resets). SMTP_HOST=stub writes JSON files instead (tests). */
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    secure: bool(process.env.SMTP_SECURE, false),
    from: process.env.MAIL_FROM || process.env.SMTP_USER || "",
  },

  email: {
    host: process.env.IMAP_HOST || "",
    port: num(process.env.IMAP_PORT, 993),
    user: process.env.IMAP_USER || "",
    pass: process.env.IMAP_PASS || "",
    mailbox: process.env.IMAP_MAILBOX || "INBOX",
    pollMin: num(process.env.EMAIL_POLL_MIN, 5),
    senderMap: parseSenderMap(process.env.EMAIL_SENDER_MAP),
    ingestAll: bool(process.env.EMAIL_INGEST_ALL, false),
  },
};

export type RouterProvider = "api" | "claude-code" | "none";

/**
 * Which Claude credential routes instructions.
 *   api         - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN through the Anthropic SDK
 *   claude-code - CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) through the Claude Agent SDK,
 *                 i.e. your Claude subscription
 *   none        - keyword routing only
 * ROUTER_PROVIDER forces one; otherwise it is picked from whichever credential is present.
 */
function routerConfig() {
  const hasApi = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasOauth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const forced = (process.env.ROUTER_PROVIDER || "").toLowerCase();
  let provider: RouterProvider = hasApi ? "api" : hasOauth ? "claude-code" : "none";
  if (forced === "api" || forced === "claude-code" || forced === "none") provider = forced;
  else if (forced === "auto" || forced === "") {
    /* keep detection */
  } else console.warn(`[config] ROUTER_PROVIDER "${forced}" is not api | claude-code | none; using ${provider}`);
  if (process.env.ROUTER_LLM && !bool(process.env.ROUTER_LLM, true)) provider = "none";
  if (provider === "claude-code" && !hasOauth) console.warn("[config] ROUTER_PROVIDER=claude-code but CLAUDE_CODE_OAUTH_TOKEN is not set");
  if (provider === "api" && !hasApi) console.warn("[config] ROUTER_PROVIDER=api but no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set");
  return {
    provider,
    llm: provider !== "none",
    /** For the API provider this is the model id; for claude-code it is passed through only when set. */
    model: process.env.ROUTER_MODEL || (provider === "claude-code" ? "" : "claude-opus-5"),
    autoThreshold: num(process.env.ROUTER_AUTO_THRESHOLD, 0.75),
    /** Wall-clock cap for one routing call. */
    timeoutMs: num(process.env.ROUTER_TIMEOUT_MS, 60_000),
  };
}

function parseSenderMap(raw: string | undefined): Record<string, string> {
  const def: Record<string, string> = {
    "openai.com": "chatgpt",
    "tm.openai.com": "chatgpt",
    "anthropic.com": "claude",
    "claude.com": "claude",
    "x.ai": "grok",
  };
  if (!raw) return def;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    console.warn("[config] EMAIL_SENDER_MAP is not valid JSON, using defaults");
  }
  return def;
}
