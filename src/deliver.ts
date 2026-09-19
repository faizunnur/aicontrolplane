import { runAction } from "./actions.js";
import { browser } from "./browser/manager.js";
import { config } from "./config.js";
import { addEvent, getAgent, getMessage, getPlatformState, updateMessage, type MessageWithAgent } from "./db.js";
import { logger } from "./logger.js";
import { getPlatform } from "./platforms.js";
import type { Agent, AgentDelivery, DeliveryMode } from "./types.js";

const log = logger("deliver");

export function parseDelivery(agent: Agent): AgentDelivery {
  try {
    const d = agent.delivery ? (JSON.parse(agent.delivery) as AgentDelivery) : null;
    if (d && typeof d === "object") return { ...d, mode: d.mode ?? "auto" };
  } catch {
    /* fall through */
  }
  return { mode: "auto" };
}

/** Pick the delivery path for an agent: explicit setting first, then a sensible default by how the agent was registered. */
export function resolveMode(agent: Agent): Exclude<DeliveryMode, "auto"> {
  const d = parseDelivery(agent);
  if (d.mode && d.mode !== "auto") return d.mode;
  if (d.webhook_url) return "webhook";
  if (agent.source === "push") return "inbox";
  const p = getPlatform(agent.platform);
  const action = d.action || "send_message";
  if (agent.source === "discovered" && browser.enabled && p?.actions?.[action]) return "browser";
  return "manual";
}

export function describeMode(mode: DeliveryMode): string {
  return {
    auto: "decided per agent",
    inbox: "the agent fetches it from its inbox on its next run",
    webhook: "posted to the agent's webhook",
    browser: "typed into the platform through the cloud browser",
    manual: "copy it and paste it into the platform yourself",
  }[mode];
}

/** Deliver an assigned message. Updates the row and returns it. Never throws. */
export async function deliverMessage(messageId: number): Promise<MessageWithAgent> {
  const msg = getMessage(messageId);
  if (!msg) throw new Error("message not found");
  if (!msg.agent_id) throw new Error("message has no agent");
  const agent = getAgent(msg.agent_id);
  if (!agent) throw new Error("agent not found");
  const mode = resolveMode(agent);
  const now = new Date().toISOString();

  try {
    switch (mode) {
      case "inbox":
      case "manual":
        return updateMessage(msg.id, { status: "assigned", delivery_mode: mode, error: null })!;

      case "webhook": {
        const d = parseDelivery(agent);
        if (!d.webhook_url) throw new Error("agent has no webhook_url");
        const res = await fetch(d.webhook_url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(d.webhook_token ? { authorization: `Bearer ${d.webhook_token}` } : {}) },
          body: JSON.stringify({
            message_id: msg.id,
            text: msg.text,
            agent: { key: agent.key, name: agent.name, platform: agent.platform },
            created_at: msg.created_at,
            ack_url: config.publicUrl ? `${config.publicUrl}/api/inbox/${msg.id}/ack` : null,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
        return updateMessage(msg.id, { status: "delivered", delivery_mode: mode, delivered_at: now, error: null })!;
      }

      case "browser": {
        const p = getPlatform(agent.platform);
        if (!p) throw new Error(`unknown platform ${agent.platform}`);
        const actionName = parseDelivery(agent).action || "send_message";
        if (!p.actions?.[actionName]) throw new Error(`platform ${p.name} has no "${actionName}" action; define one in its settings`);
        if (getPlatformState(p.id).session_status === "needs_login") throw new Error(`${p.name} needs login before messages can be sent`);
        const r = await runAction(p, actionName, agent, { message: msg.text });
        if (!r.ok) throw new Error(r.message);
        return updateMessage(msg.id, { status: "delivered", delivery_mode: mode, delivered_at: now, error: null })!;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`delivery of message ${msg.id} to ${agent.name} via ${mode} failed: ${error}`);
    addEvent({
      platform: agent.platform,
      kind: "message",
      title: `Could not deliver instruction to ${agent.name}`,
      body: `${error}\n\n"${msg.text.slice(0, 200)}"`,
      dedupe_key: `message_failed:${msg.id}`,
    });
    return updateMessage(msg.id, { status: "failed", delivery_mode: mode, error })!;
  }
  return msg;
}
