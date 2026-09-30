import { createHmac } from "node:crypto";
import { runAction } from "./actions.js";
import { ensureProviderAgent, ensureTaskAgent } from "./agents.js";

import { config } from "./config.js";
import { withLogContext } from "./context.js";
import { egressFetch } from "./egress.js";
import { addEvent, conversationThreads, getConversation, getMessage, getPlatformState, getTask, setConversationThread, updateMessage, type MessageWithTask } from "./db.js";
import { logger } from "./logger.js";
import { openMaybe } from "./secrets.js";
import { getPlatform, refreshPlatformsNow } from "./platforms.js";
import { ApprovalPending, guard, registerResumer } from "./policy.js";
import { getProvider } from "./providers/registry.js";
import { beginRun, endRun, enforceRunQuotas, QuotaExceededError, RunTracker, withRunLease } from "./runs.js";
import type { AgentDelivery, DeliveryMode, Task } from "../packages/core/src/index.js";

const log = logger("deliver");

/**
 * Another browser worker holds this (workspace, provider) session claim (fleet.ts throws it
 * by code, not by import, to keep the browser layer out of this module's graph). The attempt
 * is settled, the message handed back, and the error rethrown so the job retries per policy.
 */
const isProviderBusy = (err: unknown): boolean => err instanceof Error && (err as { code?: string }).code === "PROVIDER_BUSY";

/**
 * Workspace quotas, checked before this delivery creates its run. The daily cap settles the
 * message now (no retry can help today); the concurrency cap rethrows so the queue's backoff
 * becomes the waiting room, and the message keeps its pre-delivery status for the sweep.
 */
async function gateDeliveryQuota(messageId: number): Promise<MessageWithTask | null> {
  try {
    await enforceRunQuotas();
    return null;
  } catch (err) {
    if (err instanceof QuotaExceededError && !err.retryable) return (await updateMessage(messageId, { status: "failed", error: err.message }))!;
    if (err instanceof QuotaExceededError) await updateMessage(messageId, { error: err.message });
    throw err;
  }
}

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
  if (task.source === "discovered" && config.browser.enabled && p?.actions?.[action]) return "browser";
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

/**
 * The webhook signature: v1=hex(hmac-sha256(webhook_token, `${ts}.${rawBody}`)), keyed on the
 * same per-task token the bearer header carries. Receivers that verify it get authenticity
 * AND replay protection (check the timestamp window); ones that only check the bearer keep
 * working untouched.
 */
export function signWebhookBody(token: string, rawBody: string, tsSeconds = Math.floor(Date.now() / 1000)): { timestamp: string; signature: string } {
  const ts = String(tsSeconds);
  return { timestamp: ts, signature: `v1=${createHmac("sha256", token).update(`${ts}.${rawBody}`).digest("hex")}` };
}

async function webhookAuthHeaders(token: string | null | undefined, rawBody: string): Promise<Record<string, string>> {
  const t = await openMaybe(token ?? null);
  if (!t) return {};
  const { timestamp, signature } = signWebhookBody(t, rawBody);
  return { authorization: `Bearer ${t}`, "x-acp-timestamp": timestamp, "x-acp-signature": signature };
}

function describeRouting(routing: string | null): string {
  try {
    const r = routing ? (JSON.parse(routing) as { method?: string }) : null;
    return { mention: "you named it", only: "the only AI connected", llm: "picked by Claude", keywords: "picked by keywords", manual: "you chose it", "follow-up": "continuing this conversation" }[r?.method ?? ""] ?? "";
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
  const msg = await getMessage(messageId);
  if (!msg) throw new Error("message not found");
  let adapter = getProvider(platformId);
  if (!adapter) {
    // Another process may have added the platform moments ago; read the store once before giving up.
    await refreshPlatformsNow();
    adapter = getProvider(platformId);
  }
  if (!adapter) throw new Error(`unknown provider ${platformId}`);
  const quotaStopped = await gateDeliveryQuota(msg.id);
  if (quotaStopped) return quotaStopped;
  const p = adapter.config();
  const { run, track } = await beginRun({ kind: "chat", label: `Message to ${p.name}`, provider: p.id, message_id: msg.id, trigger: "user", agent_id: (await ensureProviderAgent(p.id))?.id ?? null });
  // Everything this run does logs with its id attached, under a heartbeat on the run's lease.
  return withRunLease(run.id, () => withLogContext({ run_id: run.id }, async () => {
    await updateMessage(msg.id, { platform: p.id, task_id: null, run_id: run.id, status: "assigned", delivery_mode: "chat", error: null, response: null, delivered_at: null, acked_at: null, steps: null });
    await track.set("route", `Sending to ${p.name}`, "done", describeRouting(msg.routing));
    // The gate comes before any browser work: under "ask" the run parks here, holding nothing.
    try {
      await guard({ runId: run.id, messageId: msg.id, provider: p.id, track, kind: "chat", checkpoint: { step: "send" } }, "send_message", `Send this to ${p.name}?`, msg.text.slice(0, 240));
    } catch (err) {
      if (err instanceof ApprovalPending) return (await getMessage(msg.id))!;
      throw err;
    }
    return performChatSend(run.id, track, msg.id, platformId);
  }));
}

/** The send segment: everything after the gate. Runs first-pass and on resume after approval. */
async function performChatSend(runId: number, track: RunTracker, messageId: number, platformId: string): Promise<MessageWithTask> {
  const msg = (await getMessage(messageId))!;
  const adapter = getProvider(platformId)!;
  const p = adapter.config();
  const fail = async (error: string, status: "failed" | "cancelled" = "failed") => {
    await track.failRunning(error);
    await endRun(runId, { status, error });
    return (await updateMessage(msg.id, { status, error }))!;
  };
  try {
    if (!adapter.supports("chat")) return fail(adapter.unsupported("chat").reason);
    // Never sit on a two-minute chat attempt against an AI that is not signed in: look first.
    let status = (await getPlatformState(p.id)).session_status;
    if (status !== "logged_in") {
      await track.start("connect", `Checking ${p.name} is connected`);
      status = await adapter.checkAuth({ messageId: msg.id, runId, track });
      if (status === "logged_in") await track.done("connect", "connected");
      else await track.fail("connect", status === "needs_login" ? "signed out" : "not reachable");
    }
    if (status !== "logged_in") {
      const error = status === "needs_login" ? `${p.name} needs you to sign in again.` : `${p.name} is not connected yet. Sign in first.`;
      await addEvent({ platform: p.id, kind: "message", title: `Could not send to ${p.name}`, body: error, dedupe_key: `message_failed:${msg.id}` });
      return fail(error);
    }
    await updateMessage(msg.id, { status: "delivered", delivered_at: new Date().toISOString() });
    // A thread that already talks to this AI continues in the SAME chat at the provider —
    // "which email provider?" answered with "gmail" must land under the question, not in a
    // fresh conversation that has never heard of email.
    const conversation = msg.conversation_id ? await getConversation(msg.conversation_id) : undefined;
    const threadUrl = conversation ? (conversationThreads(conversation)[p.id] ?? null) : null;
    const r = await adapter.sendMessage(msg.text, { messageId: msg.id, runId, track, threadUrl });
    if (r.cancelled) return fail(r.error ?? "Stopped.", "cancelled");
    if (!r.ok) {
      log.warn(`chat delivery of message ${msg.id} to ${p.name} failed: ${r.error}`);
      await addEvent({ platform: p.id, kind: "message", title: `Could not send to ${p.name}`, body: `${r.error}\n\n"${msg.text.slice(0, 200)}"`, dedupe_key: `message_failed:${msg.id}` });
      return fail(r.error ?? "unknown error");
    }
    // Remember where the provider put this chat, so the next message in this conversation
    // continues it. The new-chat URL itself is never worth saving: reopening it would start
    // over, which is exactly what this avoids.
    if (conversation && r.url && /^https?:\/\//i.test(r.url) && r.url !== (p.chatUrl || p.appUrl) && r.url !== threadUrl) {
      await setConversationThread(conversation.id, p.id, r.url).catch((err) => log.warn(`could not remember the ${p.name} thread for conversation ${conversation.id}`, err));
    }
    const response = r.reply ? (r.partial ? r.reply + "\n\n(reply was still being written when I stopped waiting)" : r.reply) : "Sent. No reply text could be read back; open the AI to see it.";
    await endRun(runId, { status: "success", summary: response.slice(0, 500), output_url: r.url ?? null });
    return (await updateMessage(msg.id, { status: "done", acked_at: new Date().toISOString(), response, error: null }))!;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (isProviderBusy(err)) {
      // This attempt's run is settled, but the message goes BACK to assigned and the error
      // is rethrown: the job retries per policy, and the next attempt gets a fresh run.
      await track.failRunning(error);
      await endRun(runId, { status: "failed", error });
      await updateMessage(msg.id, { status: "assigned", error });
      throw err;
    }
    log.error(`delivery of message ${msg.id} crashed`, err);
    return fail(error);
  }
}

registerResumer("chat", async (run) => {
  if (!run.message_id || !run.provider) {
    await endRun(run.id, { status: "failed", error: "the message behind this run is gone" });
    return;
  }
  await withRunLease(run.id, () => withLogContext({ run_id: run.id }, () => performChatSend(run.id, new RunTracker(run.id, run.message_id), run.message_id!, run.provider!)));
});

/**
 * Hand a message to a registered task's agent: inbox, webhook, browser action, or manual copy.
 * A dispatch run carries it; inbox and webhook runs stay open until the agent acknowledges.
 */
export async function deliverMessage(messageId: number): Promise<MessageWithTask> {
  const msg = await getMessage(messageId);
  if (!msg) throw new Error("message not found");
  if (!msg.task_id) throw new Error("message has no task");
  const task = await getTask(msg.task_id);
  if (!task) throw new Error("task not found");
  const mode = resolveMode(task);
  const nowIso = new Date().toISOString();
  const quotaStopped = await gateDeliveryQuota(msg.id);
  if (quotaStopped) return quotaStopped;
  const { run, track } = await beginRun({ kind: "dispatch", label: `Instruction to ${task.name}`, provider: task.platform, task_id: task.id, message_id: msg.id, trigger: "user", agent_id: task.agent_id ?? (await ensureTaskAgent(task))?.id ?? null });
  await updateMessage(msg.id, { run_id: run.id, steps: [] });

  return withRunLease(run.id, async () => {
    try {
      switch (mode) {
        case "inbox":
        case "manual":
          await track.waiting("deliver", mode === "inbox" ? `Waiting for ${task.name} to pick it up` : `Copy it into ${task.name} yourself`);
          return (await updateMessage(msg.id, { status: "assigned", delivery_mode: mode, error: null }))!;

        case "webhook": {
          const d = parseDelivery(task);
          if (!d.webhook_url) throw new Error("task has no webhook_url");
          try {
            await guard({ runId: run.id, messageId: msg.id, provider: task.platform, track, kind: "dispatch", checkpoint: { step: "deliver" } }, "dispatch_webhook", `Send this instruction to ${task.name}?`, msg.text.slice(0, 240));
          } catch (err) {
            if (err instanceof ApprovalPending) return (await updateMessage(msg.id, { status: "assigned", delivery_mode: mode }))!;
            throw err;
          }
          return performWebhookDeliver(run.id, track, msg.id);
        }

        case "browser": {
          const p = getPlatform(task.platform);
          if (!p) throw new Error(`unknown provider ${task.platform}`);
          const actionName = parseDelivery(task).action || "send_message";
          if (!p.actions?.[actionName]) throw new Error(`provider ${p.name} has no "${actionName}" action; define one in its settings`);
          if ((await getPlatformState(p.id)).session_status === "needs_login") throw new Error(`${p.name} needs login before messages can be sent`);
          await track.start("deliver", `Running "${actionName}" on ${p.name}`);
          let r;
          try {
            r = await runAction(p, actionName, task, { message: msg.text }, { messageId: msg.id, runId: run.id, track, runKind: "dispatch" });
          } catch (err) {
            if (err instanceof ApprovalPending) return (await updateMessage(msg.id, { status: "assigned", delivery_mode: mode }))!;
            throw err;
          }
          if (!r.ok) throw new Error(r.message);
          await track.done("deliver", r.message);
          await endRun(run.id, { status: "success", summary: r.message, output_url: r.url ?? null });
          return (await updateMessage(msg.id, { status: "delivered", delivery_mode: mode, delivered_at: nowIso, error: null }))!;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (isProviderBusy(err)) {
        // Settle this attempt's run, hand the message back, and let the job retry per policy.
        await track.failRunning(error);
        await endRun(run.id, { status: "failed", error });
        await updateMessage(msg.id, { status: "assigned", delivery_mode: mode, error });
        throw err;
      }
      log.warn(`delivery of message ${msg.id} to ${task.name} via ${mode} failed: ${error}`);
      await track.failRunning(error);
      await endRun(run.id, { status: "failed", error });
      await addEvent({ platform: task.platform, kind: "message", title: `Could not deliver instruction to ${task.name}`, body: `${error}\n\n"${msg.text.slice(0, 200)}"`, dedupe_key: `message_failed:${msg.id}` });
      return (await updateMessage(msg.id, { status: "failed", delivery_mode: mode, error }))!;
    }
    return msg;
  });
}

/*
  Webhook attempts and their backoff. The retries live INSIDE the handler, in one run, rather
  than as a durable webhook.deliver job: a run's outcome is single-shot (endRun refuses a
  settled run), so attempts spread over pg-boss redeliveries would each need their own run or
  an illegal failed→running reopen. Three quick tries in one run keeps the timeline honest
  (each attempt is a step detail, the final failure fails the run with the last error) and
  stays well inside the dispatch handler's watchdog deadline.
*/
const WEBHOOK_ATTEMPTS = 3;
const WEBHOOK_BACKOFF_MS = [2_000, 8_000];

/** The webhook segment: everything after the gate. Runs first-pass and on resume after approval. */
async function performWebhookDeliver(runId: number, track: RunTracker, messageId: number): Promise<MessageWithTask> {
  const msg = (await getMessage(messageId))!;
  const task = (await getTask(msg.task_id!))!;
  const d = parseDelivery(task);
  try {
    await track.start("deliver", `Posting to ${task.name}'s webhook`);
    const body = JSON.stringify({
      message_id: msg.id,
      run_id: runId,
      text: msg.text,
      agent: { key: task.key, name: task.name, platform: task.platform },
      task: { key: task.key, name: task.name, platform: task.platform },
      created_at: msg.created_at,
      ack_url: config.publicUrl ? `${config.publicUrl}/api/inbox/${msg.id}/ack` : null,
    });
    let lastError = "";
    for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await track.set("deliver", "", "running", `attempt ${attempt} of ${WEBHOOK_ATTEMPTS}: ${lastError}`);
        await new Promise((r) => setTimeout(r, WEBHOOK_BACKOFF_MS[attempt - 2]));
      }
      try {
        // Signed fresh per attempt, so a receiver enforcing a timestamp window accepts retries.
        const res = await egressFetch(d.webhook_url!, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await webhookAuthHeaders(d.webhook_token, body)) },
          body,
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          await track.done("deliver", `HTTP ${res.status}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
          await track.waiting("ack", `Waiting for ${task.name} to report back`);
          return (await updateMessage(msg.id, { status: "delivered", delivery_mode: "webhook", delivered_at: new Date().toISOString(), error: null }))!;
        }
        lastError = `webhook responded ${res.status}`;
        // A definite client-side rejection will not change on a retry; 408/429 are transient.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(lastError || "webhook delivery failed");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`delivery of message ${msg.id} to ${task.name} via webhook failed: ${error}`);
    await track.failRunning(error);
    await endRun(runId, { status: "failed", error });
    await addEvent({ platform: task.platform, kind: "message", title: `Could not deliver instruction to ${task.name}`, body: `${error}\n\n"${msg.text.slice(0, 200)}"`, dedupe_key: `message_failed:${msg.id}` });
    return (await updateMessage(msg.id, { status: "failed", delivery_mode: "webhook", error }))!;
  }
}

registerResumer("dispatch", async (run) => {
  if (!run.message_id) {
    await endRun(run.id, { status: "failed", error: "the message behind this run is gone" });
    return;
  }
  const msg = await getMessage(run.message_id);
  const task = msg?.task_id ? await getTask(msg.task_id) : undefined;
  const track = new RunTracker(run.id, run.message_id);
  if (!msg || !task) {
    await endRun(run.id, { status: "failed", error: "the message or task behind this run is gone" });
    return;
  }
  const mode = resolveMode(task);
  await withLogContext({ run_id: run.id }, async () => {
    if (mode === "webhook") {
      await performWebhookDeliver(run.id, track, msg.id);
      return;
    }
    if (mode === "browser") {
      // Re-enter the browser segment with the gate already passed.
      const p = getPlatform(task.platform);
      const actionName = parseDelivery(task).action || "send_message";
      try {
        if (!p) throw new Error(`unknown provider ${task.platform}`);
        await track.start("deliver", `Running "${actionName}" on ${p.name}`);
        const r = await runAction(p, actionName, task, { message: msg.text }, { messageId: msg.id, runId: run.id, track, approved: true });
        if (!r.ok) throw new Error(r.message);
        await track.done("deliver", r.message);
        await endRun(run.id, { status: "success", summary: r.message, output_url: r.url ?? null });
        await updateMessage(msg.id, { status: "delivered", delivery_mode: mode, delivered_at: new Date().toISOString(), error: null });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await track.failRunning(error);
        await endRun(run.id, { status: "failed", error });
        await updateMessage(msg.id, { status: "failed", delivery_mode: mode, error });
      }
      return;
    }
    await endRun(run.id, { status: "needs_attention", error: `approved, but the task's delivery mode is now "${mode}" and cannot be resumed automatically` });
  });
});
