import { runAction } from "./actions.js";
import { ensureProviderAgent, ensureTaskAgent } from "./agents.js";
import { browser } from "./browser/manager.js";
import { config } from "./config.js";
import { addEvent, getMessage, getPlatformState, getTask, updateMessage, type MessageWithTask } from "./db.js";
import { logger } from "./logger.js";
import { getPlatform } from "./platforms.js";
import { guard } from "./policy.js";
import { getProvider } from "./providers/registry.js";
import { beginRun, endRun } from "./runs.js";
import type { AgentDelivery, DeliveryMode, Task } from "./types.js";

const log = logger("deliver");

export function parseDelivery(task: Task): AgentDelivery {
  try {
    const d = task.delivery ? (JSON.parse(task.delivery) as AgentDelivery) : null;
    if (d && typeof d === "object") return { ...d, mode: d.mode ?? "auto" };
  } catch {
    /* fall through */
  }
  return { mode: "auto" };
}

/** Pick the delivery path for a task's agent: explicit setting first, then a sensible default by how the task was registered. */
export function resolveMode(task: Task): Exclude<DeliveryMode, "auto"> {
  const d = parseDelivery(task);
  if (d.mode && d.mode !== "auto") return d.mode;
  if (d.webhook_url) return "webhook";
  if (task.source === "push") return "inbox";
  const p = getPlatform(task.platform);
  const action = d.action || "send_message";
  if (task.source === "discovered" && browser.enabled && p?.actions?.[action]) return "browser";
  return "manual";
}

export function describeMode(mode: DeliveryMode): string {
  return {
    chat: "sent in the AI's chat; the answer comes back here",
    auto: "decided per task",
    inbox: "the agent fetches it from its inbox on its next run",
    webhook: "posted to the agent's webhook",
    browser: "typed into the provider through the cloud browser",
    manual: "copy it and paste it into the provider yourself",
  }[mode];
}

function describeRouting(routing: string | null): string {
  try {
    const r = routing ? (JSON.parse(routing) as { method?: string }) : null;
    return { mention: "you named it", only: "the only AI connected", llm: "picked by Claude", keywords: "picked by keywords", manual: "you chose it" }[r?.method ?? ""] ?? "";
  } catch {
    return "";
  }
}

/**
 * Send a message to a provider's chat and wait for its answer. A chat run carries the work:
 * its timeline shows in the thread, and the message row follows it: assigned → delivered → done
 * (with the reply), failed, or cancelled.
 */
export async function deliverToConnection(messageId: number, platformId: string): Promise<MessageWithTask> {
  const msg = getMessage(messageId);
  if (!msg) throw new Error("message not found");
  const adapter = getProvider(platformId);
  if (!adapter) throw new Error(`unknown provider ${platformId}`);
  const p = adapter.config();
  const { run, track } = beginRun({ kind: "chat", label: `Message to ${p.name}`, provider: p.id, message_id: msg.id, trigger: "user", agent_id: ensureProviderAgent(p.id)?.id ?? null });
  updateMessage(msg.id, { platform: p.id, task_id: null, run_id: run.id, status: "assigned", delivery_mode: "chat", error: null, response: null, delivered_at: null, acked_at: null, steps: [] });
  track.set("route", `Sending to ${p.name}`, "done", describeRouting(msg.routing));

  const fail = (error: string, status: "failed" | "cancelled" = "failed") => {
    track.failRunning(error);
    endRun(run.id, { status, error });
    return updateMessage(msg.id, { status, error })!;
  };
  try {
    if (!adapter.supports("chat")) return fail(adapter.unsupported("chat").reason);
    // Never sit on a two-minute chat attempt against an AI that is not signed in: look first.
    let status = getPlatformState(p.id).session_status;
    if (status !== "logged_in") {
      track.start("connect", `Checking ${p.name} is connected`);
      status = await adapter.checkAuth({ messageId: msg.id, runId: run.id, track });
      if (status === "logged_in") track.done("connect", "connected");
      else track.fail("connect", status === "needs_login" ? "signed out" : "not reachable");
    }
    if (status !== "logged_in") {
      const error = status === "needs_login" ? `${p.name} needs you to sign in again.` : `${p.name} is not connected yet. Sign in first.`;
      addEvent({ platform: p.id, kind: "message", title: `Could not send to ${p.name}`, body: error, dedupe_key: `message_failed:${msg.id}` });
      return fail(error);
    }
    updateMessage(msg.id, { status: "delivered", delivered_at: new Date().toISOString() });
    const r = await adapter.sendMessage(msg.text, { messageId: msg.id, runId: run.id, track });
    if (r.cancelled) return fail(r.error ?? "Stopped.", "cancelled");
    if (!r.ok) {
      log.warn(`chat delivery of message ${msg.id} to ${p.name} failed: ${r.error}`);
      addEvent({ platform: p.id, kind: "message", title: `Could not send to ${p.name}`, body: `${r.error}\n\n"${msg.text.slice(0, 200)}"`, dedupe_key: `message_failed:${msg.id}` });
      return fail(r.error ?? "unknown error");
    }
    const response = r.reply ? (r.partial ? r.reply + "\n\n(reply was still being written when I stopped waiting)" : r.reply) : "Sent. No reply text could be read back; open the AI to see it.";
    endRun(run.id, { status: "success", summary: response.slice(0, 500), output_url: r.url ?? null });
    return updateMessage(msg.id, { status: "done", acked_at: new Date().toISOString(), response, error: null })!;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`delivery of message ${msg.id} crashed`, err);
    return fail(error);
  }
}

/**
 * Hand a message to a registered task's agent: inbox, webhook, browser action, or manual copy.
 * A dispatch run carries it; inbox and webhook runs stay open until the agent acknowledges.
 */
export async function deliverMessage(messageId: number): Promise<MessageWithTask> {
  const msg = getMessage(messageId);
  if (!msg) throw new Error("message not found");
  if (!msg.task_id) throw new Error("message has no task");
  const task = getTask(msg.task_id);
  if (!task) throw new Error("task not found");
  const mode = resolveMode(task);
  const nowIso = new Date().toISOString();
  const { run, track } = beginRun({ kind: "dispatch", label: `Instruction to ${task.name}`, provider: task.platform, task_id: task.id, message_id: msg.id, trigger: "user", agent_id: task.agent_id ?? ensureTaskAgent(task)?.id ?? null });
  updateMessage(msg.id, { run_id: run.id, steps: [] });

  try {
    switch (mode) {
      case "inbox":
      case "manual":
        track.waiting("deliver", mode === "inbox" ? `Waiting for ${task.name} to pick it up` : `Copy it into ${task.name} yourself`);
        return updateMessage(msg.id, { status: "assigned", delivery_mode: mode, error: null })!;

      case "webhook": {
        const d = parseDelivery(task);
        if (!d.webhook_url) throw new Error("task has no webhook_url");
        const decision = await guard({ runId: run.id, messageId: msg.id, provider: task.platform, track }, "dispatch_webhook", `Send this instruction to ${task.name}?`, msg.text.slice(0, 240));
        if (decision !== "approved") {
          endRun(run.id, { status: "cancelled", error: decision === "timeout" ? "not approved in time" : "rejected" });
          return updateMessage(msg.id, { status: "cancelled", delivery_mode: mode, error: decision === "timeout" ? "Nobody approved it within 15 minutes, so it was not sent." : "Not sent. You rejected it." })!;
        }
        track.start("deliver", `Posting to ${task.name}'s webhook`);
        const res = await fetch(d.webhook_url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(d.webhook_token ? { authorization: `Bearer ${d.webhook_token}` } : {}) },
          body: JSON.stringify({
            message_id: msg.id,
            run_id: run.id,
            text: msg.text,
            agent: { key: task.key, name: task.name, platform: task.platform },
            task: { key: task.key, name: task.name, platform: task.platform },
            created_at: msg.created_at,
            ack_url: config.publicUrl ? `${config.publicUrl}/api/inbox/${msg.id}/ack` : null,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
        track.done("deliver", `HTTP ${res.status}`);
        track.waiting("ack", `Waiting for ${task.name} to report back`);
        return updateMessage(msg.id, { status: "delivered", delivery_mode: mode, delivered_at: nowIso, error: null })!;
      }

      case "browser": {
        const p = getPlatform(task.platform);
        if (!p) throw new Error(`unknown provider ${task.platform}`);
        const actionName = parseDelivery(task).action || "send_message";
        if (!p.actions?.[actionName]) throw new Error(`provider ${p.name} has no "${actionName}" action; define one in its settings`);
        if (getPlatformState(p.id).session_status === "needs_login") throw new Error(`${p.name} needs login before messages can be sent`);
        track.start("deliver", `Running "${actionName}" on ${p.name}`);
        const r = await runAction(p, actionName, task, { message: msg.text }, { messageId: msg.id, runId: run.id, track });
        if (!r.ok) throw new Error(r.message);
        track.done("deliver", r.message);
        endRun(run.id, { status: "success", summary: r.message, output_url: r.url ?? null });
        return updateMessage(msg.id, { status: "delivered", delivery_mode: mode, delivered_at: nowIso, error: null })!;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`delivery of message ${msg.id} to ${task.name} via ${mode} failed: ${error}`);
    track.failRunning(error);
    endRun(run.id, { status: "failed", error });
    addEvent({ platform: task.platform, kind: "message", title: `Could not deliver instruction to ${task.name}`, body: `${error}\n\n"${msg.text.slice(0, 200)}"`, dedupe_key: `message_failed:${msg.id}` });
    return updateMessage(msg.id, { status: "failed", delivery_mode: mode, error })!;
  }
  return msg;
}
