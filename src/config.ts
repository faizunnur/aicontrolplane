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
const dataDir = path.resolve(process.env.DATA_DIR || "./data");

let adminToken = process.env.ACP_ADMIN_TOKEN || "";
if (!adminToken) {
  if (isProd) {
    adminToken = randomBytes(24).toString("hex");
    console.warn(`[config] ACP_ADMIN_TOKEN not set. Generated one for this boot: ${adminToken}`);
  } else {
    adminToken = "dev";
    console.warn("[config] ACP_ADMIN_TOKEN not set. Using 'dev' (development only).");
  }
}
let ingestToken = process.env.ACP_INGEST_TOKEN || "";
if (!ingestToken) {
  ingestToken = isProd ? randomBytes(24).toString("hex") : "dev-ingest";
  console.warn(`[config] ACP_INGEST_TOKEN not set. Using: ${ingestToken}`);
}

export const config = {
  isProd,
  port: num(process.env.PORT, 8080),
  dataDir,
  dbPath: path.join(dataDir, "acp.sqlite"),
  profileDir: path.join(dataDir, "profile"),
  screenshotDir: path.join(dataDir, "screenshots"),
  platformsFile: path.join(dataDir, "platforms.json"),
  adminToken,
  ingestToken,
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/$/, ""),

  browser: {
    enabled: bool(process.env.BROWSER_ENABLED, true),
    headless: bool(process.env.HEADLESS, false),
    channel: process.env.BROWSER_CHANNEL || undefined,
    windowSize: (process.env.SCREEN_GEOMETRY || "1600x1000x24").split("x").slice(0, 2).map(Number) as [number, number],
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
