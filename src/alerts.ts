import { config } from "./config.js";
import { logger } from "./logger.js";

const log = logger("alerts");
const lastSent = new Map<string, number>();

export interface AlertInput {
  /** Cooldown key, e.g. "session:chatgpt". Same key is not re-sent within ALERT_COOLDOWN_MIN. */
  key: string;
  title: string;
  body?: string;
  link?: string;
  force?: boolean;
}

export function alertsConfigured(): boolean {
  return !!(config.alerts.webhookUrl || (config.alerts.telegramToken && config.alerts.telegramChatId));
}

/** Fire-and-forget outbound notification. Never throws. Returns true when something was sent. */
export async function sendAlert(a: AlertInput): Promise<boolean> {
  if (!alertsConfigured()) return false;
  const nowMs = Date.now();
  const last = lastSent.get(a.key) ?? 0;
  if (!a.force && nowMs - last < config.alerts.cooldownMin * 60_000) return false;
  lastSent.set(a.key, nowMs);

  const link = a.link || config.publicUrl || "";
  const text = [`⚠️ ${a.title}`, a.body, link].filter(Boolean).join("\n");
  let sent = false;

  if (config.alerts.webhookUrl) {
    try {
      const res = await fetch(config.alerts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: a.key, title: a.title, body: a.body ?? "", link, text, at: new Date().toISOString() }),
      });
      sent ||= res.ok;
      if (!res.ok) log.warn(`webhook responded ${res.status}`);
    } catch (err) {
      log.warn("webhook failed", err);
    }
  }
  if (config.alerts.telegramToken && config.alerts.telegramChatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.alerts.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: config.alerts.telegramChatId, text, disable_web_page_preview: true }),
      });
      sent ||= res.ok;
      if (!res.ok) log.warn(`telegram responded ${res.status}`);
    } catch (err) {
      log.warn("telegram failed", err);
    }
  }
  return sent;
}
