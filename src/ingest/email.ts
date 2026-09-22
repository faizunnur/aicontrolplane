import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { sendAlert } from "../alerts.js";
import { config } from "../config.js";
import { addEvent, listTasks, recordRun } from "../db.js";
import { logger } from "../logger.js";
import { mapRunStatus } from "../providers/browser/normalize.js";

const log = logger("email");

let timer: NodeJS.Timeout | null = null;
let polling = false;
let lastPollAt: string | null = null;
let lastError: string | null = null;
let ingestedTotal = 0;

export function emailConfigured(): boolean {
  return !!(config.email.host && config.email.user && config.email.pass);
}

export function emailStatus() {
  return { configured: emailConfigured(), lastPollAt, lastError, ingestedTotal, pollMin: config.email.pollMin };
}

export function startEmailPoller() {
  if (!emailConfigured()) {
    log.info("IMAP not configured, email ingestion off");
    return;
  }
  const loop = async () => {
    try {
      await pollOnce();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn("poll failed", err);
    } finally {
      timer = setTimeout(loop, config.email.pollMin * 60_000);
      timer.unref?.();
    }
  };
  timer = setTimeout(loop, 15_000);
  timer.unref?.();
  log.info(`email poller armed: every ${config.email.pollMin} min (${config.email.user}@${config.email.host})`);
}

function platformForSender(address: string): string | null {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  for (const [d, platform] of Object.entries(config.email.senderMap)) {
    if (domain === d.toLowerCase() || domain.endsWith("." + d.toLowerCase())) return platform;
  }
  return config.email.ingestAll ? "custom" : null;
}

/** Fetch unseen messages, turn matching ones into events (and runs when an agent name matches). */
export async function pollOnce(): Promise<number> {
  if (polling) return 0;
  polling = true;
  let count = 0;
  const client = new ImapFlow({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port === 993,
    auth: { user: config.email.user, pass: config.email.pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.email.mailbox);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      const list = Array.isArray(uids) ? uids : [];
      for (const uid of list.slice(-50)) {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0]?.address ?? "";
        const platform = platformForSender(from);
        if (!platform) continue;

        const subject = parsed.subject ?? "(no subject)";
        const html = typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "";
        const text = (parsed.text ?? html).replace(/\s+\n/g, "\n").trim().slice(0, 8_000);
        const occurred = (parsed.date ?? new Date()).toISOString();
        const messageId = parsed.messageId ?? `${from}:${occurred}:${subject}`;
        const link = firstUrl(text);

        const ev = addEvent({
          platform,
          kind: "email",
          title: subject,
          body: text,
          link,
          occurred_at: occurred,
          dedupe_key: `email:${messageId}`,
        });
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        if (!ev) continue;
        count++;
        ingestedTotal++;

        const agent = matchAgent(platform, subject, text);
        if (agent) {
          const status = mapRunStatus(subject + " " + text.slice(0, 300));
          recordRun({
            task_id: agent.id,
            kind: "email",
            provider: platform,
            trigger: "push",
            external_id: `email:${messageId}`,
            status: status === "unknown" ? "success" : status,
            finished_at: occurred,
            summary: subject,
            details: text.slice(0, 2_000),
            output_url: link,
            source: "email",
          });
          if (status === "failed" || status === "needs_attention") {
            void sendAlert({ key: `run:${agent.id}`, title: `${agent.name} ${status}`, body: subject, link: link ?? undefined });
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    lastPollAt = new Date().toISOString();
    lastError = null;
    if (count) log.info(`ingested ${count} email(s)`);
    return count;
  } finally {
    polling = false;
    client.close();
  }
}

function matchAgent(platform: string, subject: string, text: string) {
  const hay = (subject + "\n" + text.slice(0, 1_000)).toLowerCase();
  const candidates = listTasks({ platform, includeDisabled: true }).filter((a) => a.name.length >= 4);
  candidates.sort((a, b) => b.name.length - a.name.length);
  return candidates.find((a) => hay.includes(a.name.toLowerCase()));
}

function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]]+/i.exec(text);
  return m ? m[0] : null;
}
