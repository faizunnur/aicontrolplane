import fs from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { availableActions, runAction } from "../actions.js";
import { alertsConfigured, sendAlert } from "../alerts.js";
import { approvalMode, decide, pendingApprovals, setApprovalMode } from "../approvals.js";
import { liveViewers } from "../browser/live.js";
import { browser, storageInfo, vncState } from "../browser/manager.js";
import { config } from "../config.js";
import {
  addEvent,
  allPlatformStates,
  conversationMessages,
  createConversation,
  createMessage,
  deleteAgent,
  deleteConversation,
  deleteMessage,
  findAgent,
  getAgent,
  getCapture,
  getConversation,
  getMessage,
  getPlatformState,
  inboxFor,
  listAgents,
  listCaptures,
  listConversations,
  listEvents,
  listMessages,
  listRuns,
  markAllEventsRead,
  markEventRead,
  openMessageCount,
  overviewCounts,
  recentStatusesByAgent,
  recentSyncLogs,
  recordRun,
  runStats,
  updateAgent,
  updateConversation,
  updateMessage,
  upsertAgent,
} from "../db.js";
import { deliverMessage } from "../deliver.js";
import { streamClients, streamHandler } from "../live.js";
import { routeMessage } from "../router.js";
import { requestCancel, StepTracker } from "../steps.js";
import { connectionCard, expandMessage } from "../view.js";
import { emailStatus, pollOnce } from "../ingest/email.js";
import { deletePlatformOverride, getPlatform, getPlatforms, savePlatformOverride, visiblePlatforms } from "../platforms.js";
import {
  adminFromEnv,
  changeAdminPassword,
  clearSessionCookieHeader,
  createAdminPassword,
  ingestToken,
  requireAdmin,
  requireIngest,
  rotateIngestToken,
  sessionCookieHeader,
  setupRequired,
  verifyAdmin,
} from "../auth.js";
import { isSyncRunning, schedulerStatus, syncAll } from "../sync.js";
import { syncPlatform } from "../collect/collector.js";
import { checkConnection } from "../collect/chat.js";
import { deliverToConnection } from "../deliver.js";
import { connectedPlatforms, routeToConnection } from "../router.js";

export const api = Router();

const RUN_STATUS = z.enum(["success", "failed", "running", "needs_attention", "unknown"]);
const DELIVERY = z
  .object({
    mode: z.enum(["auto", "inbox", "webhook", "browser", "manual"]).default("auto"),
    webhook_url: z.string().max(2000).optional(),
    webhook_token: z.string().max(500).optional(),
    action: z.string().max(80).optional(),
  })
  .nullable();

async function assignAndDeliver(messageId: number, agentId: number) {
  updateMessage(messageId, { agent_id: agentId, status: "assigned", error: null, delivered_at: null, acked_at: null });
  return expandMessage(await deliverMessage(messageId));
}

function bad(res: Response, msg: string, code = 400) {
  res.status(code).json({ error: msg });
}
function num(v: unknown, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function secure(req: Request) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/* ---------- auth & first run ---------- */

api.get("/setup", (_req, res) => res.json({ setupRequired: setupRequired(), passwordFromEnv: adminFromEnv() }));
api.post("/setup", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < 8) return bad(res, "Use at least 8 characters.");
  if (!createAdminPassword(password)) return bad(res, "A password already exists. Sign in instead.", 409);
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req)));
  res.json({ ok: true });
});
api.post("/session", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : typeof req.body?.password === "string" ? req.body.password : "";
  if (!verifyAdmin(token)) return res.status(401).json({ error: "That password was not accepted.", setup: setupRequired() });
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req)));
  res.json({ ok: true });
});
api.delete("/session", (_req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookieHeader());
  res.json({ ok: true });
});
api.get("/session", requireAdmin, (_req, res) => {
  res.json({ ok: true, admin: true, publicUrl: config.publicUrl });
});

/* ---------- ingest (push from agents) ---------- */

const ingestSchema = z.object({
  agent: z.object({
    key: z.string().min(1).max(200),
    platform: z.string().min(1).max(50).default("custom"),
    name: z.string().max(200).optional(),
    purpose: z.string().max(2000).optional(),
    schedule: z.string().max(200).optional(),
    native_url: z.string().max(2000).optional(),
    status: z.string().max(60).optional(),
    keywords: z.string().max(500).optional(),
    delivery: DELIVERY.optional(),
  }),
  run: z
    .object({
      external_id: z.string().max(200).optional(),
      status: RUN_STATUS.default("success"),
      started_at: z.string().optional(),
      finished_at: z.string().optional(),
      summary: z.string().max(4000).optional(),
      details: z.string().max(50_000).optional(),
      output_url: z.string().max(2000).optional(),
      raw: z.unknown().optional(),
    })
    .optional(),
  event: z
    .object({
      kind: z.string().max(40).default("notification"),
      title: z.string().min(1).max(300),
      body: z.string().max(20_000).optional(),
      link: z.string().max(2000).optional(),
    })
    .optional(),
});

api.post("/ingest", requireIngest, async (req, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid payload", issues: parsed.error.issues });
  const { agent: a, run, event } = parsed.data;
  const platform = a.platform.toLowerCase();
  const agent = upsertAgent({
    platform,
    key: a.key,
    name: a.name,
    source: "push",
    purpose: a.purpose,
    schedule: a.schedule,
    native_url: a.native_url,
    status: a.status,
    keywords: a.keywords,
    delivery: a.delivery === undefined ? undefined : a.delivery,
  });
  let runRow = null;
  if (run) {
    const r = recordRun({
      agent_id: agent.id,
      external_id: run.external_id ?? null,
      status: run.status,
      started_at: run.started_at ?? null,
      finished_at: run.finished_at ?? new Date().toISOString(),
      summary: run.summary ?? null,
      details: run.details ?? null,
      output_url: run.output_url ?? null,
      source: "push",
      raw: run.raw,
    });
    runRow = r.run;
    if (r.created && (run.status === "failed" || run.status === "needs_attention")) {
      addEvent({
        platform,
        kind: "run",
        title: `${agent.name}: ${run.status.replace("_", " ")}`,
        body: run.summary ?? null,
        link: run.output_url ?? agent.native_url,
        dedupe_key: run.external_id ? `run:${agent.id}:${run.external_id}` : null,
      });
      void sendAlert({ key: `run:${agent.id}`, title: `${agent.name} ${run.status}`, body: run.summary, link: run.output_url });
    }
  }
  let eventRow = null;
  if (event) {
    eventRow = addEvent({ platform, kind: event.kind, title: event.title, body: event.body ?? null, link: event.link ?? null });
  }
  res.json({ ok: true, agent, run: runRow, event: eventRow });
});

/* ---------- inbox (agents pull their instructions; ingest token) ---------- */

api.get("/inbox", requireIngest, (req, res) => {
  const platform = String(req.query.platform ?? "").toLowerCase();
  const key = String(req.query.key ?? "");
  if (!platform || !key) return bad(res, "platform and key are required");
  const agent = findAgent(platform, key);
  if (!agent) return bad(res, "unknown agent", 404);
  const now = new Date().toISOString();
  const messages = inboxFor(agent.id).map((m) => {
    if (m.status === "assigned") updateMessage(m.id, { status: "delivered", delivered_at: now });
    return { id: m.id, text: m.text, created_at: m.created_at, ack_url: `/api/inbox/${m.id}/ack` };
  });
  res.json({ agent: { key: agent.key, name: agent.name, platform: agent.platform }, messages });
});

const ackSchema = z.object({
  status: z.enum(["acknowledged", "done", "failed"]).default("done"),
  response: z.string().max(20_000).optional(),
});
api.post("/inbox/:id/ack", requireIngest, (req, res) => {
  const parsed = ackSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid ack", issues: parsed.error.issues });
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const updated = updateMessage(m.id, {
    status: parsed.data.status,
    acked_at: new Date().toISOString(),
    response: parsed.data.response ?? null,
    error: parsed.data.status === "failed" ? (parsed.data.response ?? "agent reported failure") : null,
  })!;
  if (parsed.data.status === "failed") {
    addEvent({
      platform: updated.agent_platform,
      kind: "message",
      title: `${updated.agent_name ?? "Agent"} could not complete an instruction`,
      body: `${parsed.data.response ?? ""}\n\n"${updated.text.slice(0, 200)}"`,
      dedupe_key: `message_agent_failed:${updated.id}`,
    });
  }
  res.json({ ok: true, message: expandMessage(updated) });
});

/* ---------- everything below is admin ---------- */

api.use(requireAdmin);

/* ---------- the app: connections, chat, home ---------- */

/** Live updates for the workspace (server-sent events). */
api.get("/stream", streamHandler);

api.get("/connections", (_req, res) => res.json(visiblePlatforms().map(connectionCard)));

const connectionPatch = z
  .object({
    name: z.string().min(1).max(80),
    purpose: z.string().max(300),
    appUrl: z.string().max(2000),
    chatUrl: z.string().max(2000),
    tasksUrl: z.string().max(2000),
    composerSelector: z.string().max(300),
    sendSelector: z.string().max(300),
    replySelector: z.string().max(500),
    busySelector: z.string().max(300),
    loggedOutSelector: z.string().max(300),
    loginUrlPatterns: z.array(z.string().max(300)).max(30),
    sessionCookie: z.string().max(120),
    cookieDomain: z.string().max(120),
    capturePatterns: z.array(z.string().max(300)).max(30),
    hidden: z.boolean(),
  })
  .partial();
api.post("/connections", (req, res) => {
  const parsed = connectionPatch.safeParse(req.body);
  if (!parsed.success || !parsed.data.name) return bad(res, "name is required");
  const id = (typeof req.body?.id === "string" && req.body.id ? req.body.id : parsed.data.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!id || getPlatform(id)?.appUrl) return bad(res, "an AI with that name already exists");
  const appUrl = parsed.data.appUrl || "";
  if (appUrl && !/^https?:\/\//.test(appUrl)) return bad(res, "URL must start with http:// or https://");
  savePlatformOverride(id, { ...parsed.data, hidden: false, chatUrl: parsed.data.chatUrl || appUrl, composerSelector: parsed.data.composerSelector || (appUrl ? "textarea, div[contenteditable=\"true\"]" : ""), replySelector: parsed.data.replySelector || "" });
  res.json(connectionCard(getPlatform(id)!));
});
api.put("/connections/:id", (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown AI", 404);
  const parsed = connectionPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid settings", issues: parsed.error.issues });
  savePlatformOverride(p.id, parsed.data);
  res.json(connectionCard(getPlatform(p.id)!));
});
api.delete("/connections/:id", (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown AI", 404);
  if (["chatgpt", "claude", "grok"].includes(p.id)) savePlatformOverride(p.id, { hidden: true });
  else deletePlatformOverride(p.id);
  res.json({ ok: true });
});
api.post("/connections/:id/restore", (req, res) => {
  deletePlatformOverride(req.params.id);
  const p = getPlatform(req.params.id);
  res.json(p ? connectionCard(p) : { ok: true });
});
/** Bring the AI's sign-in page up in its tab; the live view then shows that tab for the user to sign in. */
api.post("/connections/:id/connect", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p || !p.appUrl) return bad(res, "this AI has no web address to open", 404);
  if (!browser.enabled) return bad(res, "the browser is disabled on this deployment", 409);
  await browser.withLock(() => browser.consolePage(p.id, p.appUrl), { label: `Opening ${p.name}`, platform: p.id });
  res.json({ ok: true, platform: p.id, screen: "/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify&reconnect=1" });
});
/** After signing in: confirm the session and capture a screenshot. */
api.post("/connections/:id/check", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p || !p.appUrl) return bad(res, "unknown AI", 404);
  const status = await checkConnection(p);
  res.json({ ...connectionCard(getPlatform(p.id)!), status });
});

/* conversations (threads in the chat panel) */
api.get("/conversations", (_req, res) => res.json(listConversations()));
api.post("/conversations", (req, res) => res.json(createConversation(typeof req.body?.title === "string" ? req.body.title : "")));
api.get("/conversations/:id", (req, res) => {
  const c = getConversation(num(req.params.id, 0));
  if (!c) return bad(res, "not found", 404);
  res.json({ conversation: c, messages: conversationMessages(c.id).map(expandMessage) });
});
api.patch("/conversations/:id", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
  const c = updateConversation(num(req.params.id, 0), { title });
  if (!c) return bad(res, "not found", 404);
  res.json(c);
});
api.delete("/conversations/:id", (req, res) => res.json({ ok: deleteConversation(num(req.params.id, 0)) }));

/* chat */
const titleFrom = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 56 ? line.slice(0, 55).replace(/\s+\S*$/, "") + "…" : line;
};
api.get("/chat", (req, res) => {
  const cid = num(req.query.conversation_id, 0);
  if (cid) return res.json(conversationMessages(cid, num(req.query.limit, 300)).map(expandMessage));
  res.json(listMessages({ limit: num(req.query.limit, 40) }).map(expandMessage).reverse());
});
api.post("/chat", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return bad(res, "Type something first.");
  if (text.length > 20_000) return bad(res, "That message is too long.");
  const chosen = typeof req.body?.platform === "string" && req.body.platform ? req.body.platform : null;
  if (chosen && !getPlatform(chosen)) return bad(res, "unknown AI", 404);
  let conversation = req.body?.conversation_id ? getConversation(num(req.body.conversation_id, 0)) : undefined;
  if (!conversation) conversation = createConversation(titleFrom(text));
  else if (!conversation.title) conversation = updateConversation(conversation.id, { title: titleFrom(text) })!;
  const msg = createMessage(text, conversation.id);
  const track = new StepTracker(msg.id);
  if (chosen) {
    updateMessage(msg.id, { routing: { method: "manual", confidence: 1, reason: "You chose it." } });
    track.set("route", `Sending to ${getPlatform(chosen)!.name}`, "done", "you chose it");
    // Respond right away; the reply lands in the thread when the AI answers.
    res.json({ message: expandMessage(getMessage(msg.id)!), routed: chosen, conversation: getConversation(conversation.id) });
    void deliverToConnection(msg.id, chosen);
    return;
  }
  track.set("route", "Choosing the AI", "running");
  const routing = await routeToConnection(text);
  updateMessage(msg.id, {
    suggestions: routing.options,
    routing: { method: routing.method, confidence: routing.top?.confidence ?? 0, reason: routing.reason, llm_error: routing.llm_error },
  });
  if (routing.top && routing.top.confidence >= config.router.autoThreshold) {
    const how = routing.method === "mention" ? "you named it" : routing.method === "only" ? "the only AI connected" : routing.method === "llm" ? "picked by Claude" : "picked by keywords";
    track.set("route", `Sending to ${routing.top.name}`, "done", how);
    res.json({ message: expandMessage(getMessage(msg.id)!), routed: routing.top.platform, conversation: getConversation(conversation.id) });
    void deliverToConnection(msg.id, routing.top.platform);
    return;
  }
  track.set("route", "Which AI should do this?", "waiting", routing.reason);
  res.json({ message: expandMessage(getMessage(msg.id)!), routed: null, conversation: getConversation(conversation.id) });
});
api.post("/chat/:id/send", async (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const platform = String(req.body?.platform ?? "");
  const p = getPlatform(platform);
  if (!p) return bad(res, "unknown AI", 404);
  new StepTracker(m.id).set("route", `Sending to ${p.name}`, "done", "you chose it");
  res.json({ ok: true });
  void deliverToConnection(m.id, platform);
});
/** Manual mode: the agent paused before an action and waits for this. */
api.post("/chat/:id/approve", (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const decision = req.body?.decision === "reject" || req.body?.decision === "rejected" ? "rejected" : "approved";
  if (!decide(m.id, decision)) return bad(res, "nothing is waiting for approval on this message", 409);
  res.json({ ok: true, decision });
});
/** Stop a task that is running. If the message was already sent, only the wait is stopped. */
api.post("/chat/:id/cancel", (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  if (!["assigned", "delivered"].includes(m.status)) return bad(res, "nothing is running for this message", 409);
  requestCancel(m.id);
  decide(m.id, "rejected");
  res.json({ ok: true });
});
api.delete("/chat/:id", (req, res) => res.json({ ok: deleteMessage(num(req.params.id, 0)) }));

/* execution mode: auto (the agent acts on its own) or manual (it asks before acting) */
api.get("/settings/approval", (_req, res) => res.json({ approvalMode: approvalMode(), pending: pendingApprovals() }));
api.put("/settings/approval", (req, res) => {
  const mode = req.body?.approvalMode === "manual" ? "manual" : req.body?.approvalMode === "auto" ? "auto" : null;
  if (!mode) return bad(res, "approvalMode must be auto or manual");
  setApprovalMode(mode);
  res.json({ approvalMode: mode });
});

/* one call for the whole app */
api.get("/home", async (req, res) => {
  const connections = visiblePlatforms().map(connectionCard);
  const conversations = listConversations();
  const wanted = num(req.query.conversation_id, 0);
  const current = (wanted ? getConversation(wanted) : undefined) ?? conversations[0] ?? null;
  const runs = listRuns({ limit: 15 }).map((r) => ({ kind: "run", at: r.finished_at || r.started_at || r.created_at, platform: r.platform, title: r.agent_name, status: r.status, summary: r.summary, link: r.output_url || r.agent_native_url }));
  const events = listEvents({ limit: 15 }).map((e) => ({ kind: e.kind, at: e.occurred_at, platform: e.platform, title: e.title, status: e.kind === "run" ? "failed" : e.kind === "session" ? "needs_attention" : "info", summary: e.body, link: e.link, id: e.id, read: !!e.read }));
  const activity = [...runs, ...events].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
  const attention = [
    ...connections.filter((c) => c.status === "needs_login").map((c) => ({ kind: "session", platform: c.id, title: `${c.name} needs you to sign in again`, action: "connect" })),
    ...listMessages({ status: "needs_assignment", limit: 10 }).map((m) => ({ kind: "message", id: m.id, title: "Which AI should do this?", body: m.text, action: "choose" })),
    ...listMessages({ status: "failed", limit: 10 }).map((m) => ({ kind: "message", id: m.id, title: "Could not send an instruction", body: m.error ?? m.text, action: "retry" })),
    ...listEvents({ unread: true, limit: 10 }).filter((e) => e.kind === "run").map((e) => ({ kind: "run", id: e.id, platform: e.platform, title: e.title, body: e.body, link: e.link, action: "dismiss" })),
  ];
  res.json({
    connections,
    conversations,
    conversation: current,
    messages: current ? conversationMessages(current.id).map(expandMessage) : [],
    approvalMode: approvalMode(),
    attention,
    activity,
    router: { llm: config.router.llm, provider: config.router.provider, model: config.router.model, autoThreshold: config.router.autoThreshold },
    storage: storageInfo(),
    browser: await browser.status(),
    scheduler: schedulerStatus(),
    alerts: { configured: alertsConfigured() },
    email: emailStatus(),
    publicUrl: config.publicUrl,
    connectedCount: connectedPlatforms().length,
    viewers: { stream: streamClients(), live: liveViewers() },
  });
});

/* settings */
api.get("/settings", (_req, res) => {
  res.json({
    passwordFromEnv: adminFromEnv(),
    ingestToken: ingestToken(),
    ingestTokenFromEnv: !!process.env.ACP_INGEST_TOKEN,
    router: { provider: config.router.provider, model: config.router.model, llm: config.router.llm },
    alerts: { webhook: !!config.alerts.webhookUrl, telegram: !!(config.alerts.telegramToken && config.alerts.telegramChatId) },
    email: emailStatus(),
    storage: storageInfo(),
    syncIntervalMin: config.sync.intervalMin,
  });
});
api.post("/settings/password", (req, res) => {
  const current = String(req.body?.current ?? "");
  const next = String(req.body?.next ?? "");
  if (next.length < 8) return bad(res, "Use at least 8 characters.");
  if (adminFromEnv()) return bad(res, "The password is set by ACP_ADMIN_TOKEN on the server; change it there.", 409);
  if (!changeAdminPassword(current, next)) return bad(res, "Current password is wrong.", 401);
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req)));
  res.json({ ok: true });
});
api.post("/settings/ingest-token/rotate", (_req, res) => res.json({ ingestToken: rotateIngestToken(), fromEnv: !!process.env.ACP_INGEST_TOKEN }));

/* ---------- messages (instructions from you, routed to agents) ---------- */

api.get("/messages", (req, res) => {
  res.json(
    listMessages({
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      agent_id: req.query.agent_id ? num(req.query.agent_id, 0) : undefined,
      limit: num(req.query.limit, 50),
    }).map(expandMessage),
  );
});
api.get("/messages/:id", (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  res.json(expandMessage(m));
});
api.post("/messages", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return bad(res, "text is required");
  if (text.length > 20_000) return bad(res, "text too long");
  const auto = req.body?.auto !== false;
  const msg = createMessage(text);

  if (req.body?.agent_id) {
    const agent = getAgent(num(req.body.agent_id, 0));
    if (!agent) return bad(res, "unknown agent", 404);
    updateMessage(msg.id, { routing: { method: "manual", confidence: 1, reason: "You chose the agent." } });
    return res.json({ message: await assignAndDeliver(msg.id, agent.id), auto_assigned: false, chosen: true });
  }

  const routing = await routeMessage(text);
  updateMessage(msg.id, {
    suggestions: routing.suggestions,
    routing: { method: routing.method, confidence: routing.confidence, reason: routing.reason, new_agent: routing.new_agent, llm_error: routing.llm_error },
  });
  if (auto && routing.top && routing.confidence >= config.router.autoThreshold) {
    return res.json({ message: await assignAndDeliver(msg.id, routing.top.agent_id), auto_assigned: true });
  }
  addEvent({
    kind: "message",
    title: routing.top ? "Instruction needs your confirmation" : "Instruction has no matching agent",
    body: text.slice(0, 300),
    dedupe_key: `message_assign:${msg.id}`,
  });
  res.json({ message: expandMessage(getMessage(msg.id)!), auto_assigned: false });
});
api.post("/messages/:id/assign", async (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const agent = getAgent(num(req.body?.agent_id, 0));
  if (!agent) return bad(res, "unknown agent", 404);
  res.json(await assignAndDeliver(m.id, agent.id));
});
api.post("/messages/:id/retry", async (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  if (!m.agent_id) return bad(res, "message has no agent; assign it first", 409);
  res.json(await assignAndDeliver(m.id, m.agent_id));
});
api.post("/messages/:id/reroute", async (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const routing = await routeMessage(m.text);
  const updated = updateMessage(m.id, {
    status: "needs_assignment",
    agent_id: null,
    delivery_mode: null,
    error: null,
    suggestions: routing.suggestions,
    routing: { method: routing.method, confidence: routing.confidence, reason: routing.reason, new_agent: routing.new_agent, llm_error: routing.llm_error },
  })!;
  res.json(expandMessage(updated));
});
api.post("/messages/:id/status", (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const status = String(req.body?.status ?? "");
  if (!["done", "failed", "acknowledged", "delivered"].includes(status)) return bad(res, "invalid status");
  const response = typeof req.body?.response === "string" ? req.body.response : undefined;
  res.json(expandMessage(updateMessage(m.id, { status: status as "done", acked_at: new Date().toISOString(), response })!));
});
api.delete("/messages/:id", (req, res) => res.json({ ok: deleteMessage(num(req.params.id, 0)) }));

api.get("/overview", async (_req, res) => {
  const platforms = getPlatforms();
  const states = Object.fromEntries(allPlatformStates().map((s) => [s.platform, s]));
  const cards = Object.values(platforms).map((p) => {
    const s = states[p.id] ?? getPlatformState(p.id);
    let meta: Record<string, unknown> = {};
    try {
      meta = s.meta ? JSON.parse(s.meta) : {};
    } catch {
      meta = {};
    }
    return {
      ...p,
      syncable: !!p.tasksUrl,
      state: { ...s, meta: { finalUrl: meta.finalUrl, title: meta.title, snapshotAt: meta.snapshotAt } },
      hasScreenshot: !!(s.screenshot_path && fs.existsSync(s.screenshot_path)),
      agents: listAgents({ platform: p.id }).length,
      actions: availableActions(p),
    };
  });
  res.json({
    counts: { ...overviewCounts(), openMessages: openMessageCount() },
    platforms: cards,
    attention: {
      runs: listRuns({ limit: 20 }).filter((r) => r.status === "failed" || r.status === "needs_attention"),
      events: listEvents({ unread: true, limit: 20 }),
      sessions: cards.filter((c) => c.state.session_status === "needs_login").map((c) => ({ platform: c.id, name: c.name })),
      messages: [...listMessages({ status: "needs_assignment", limit: 10 }), ...listMessages({ status: "failed", limit: 10 })].map(expandMessage),
    },
    router: { llm: config.router.llm, provider: config.router.provider, model: config.router.model, autoThreshold: config.router.autoThreshold },
    storage: storageInfo(),
    scheduler: schedulerStatus(),
    browser: await browser.status(),
    email: emailStatus(),
    alerts: { configured: alertsConfigured() },
    publicUrl: config.publicUrl,
  });
});

/* ---------- agents (registry) ---------- */

const agentSchema = z.object({
  platform: z.string().min(1).max(50),
  key: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200),
  purpose: z.string().max(2000).nullable().optional(),
  schedule: z.string().max(200).nullable().optional(),
  native_url: z.string().max(2000).nullable().optional(),
  status: z.string().max(60).nullable().optional(),
  enabled: z.boolean().optional(),
  keywords: z.string().max(500).nullable().optional(),
  delivery: DELIVERY.optional(),
});

api.get("/agents", (req, res) => {
  const recent = recentStatusesByAgent(6);
  res.json(
    listAgents({ platform: typeof req.query.platform === "string" ? req.query.platform : undefined, includeDisabled: req.query.all === "1" }).map((a) => ({
      ...a,
      recent_statuses: recent[a.id] ?? [],
    })),
  );
});

/* ---------- stats ---------- */

api.get("/stats/runs", (req, res) => res.json(runStats(num(req.query.days, 14))));
api.post("/agents", (req, res) => {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const d = parsed.data;
  const key = d.key || d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `agent-${Date.now()}`;
  res.json(upsertAgent({ ...d, key, platform: d.platform.toLowerCase(), source: "registry" }));
});
api.put("/agents/:id", (req, res) => {
  const parsed = agentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const a = updateAgent(num(req.params.id, 0), parsed.data);
  if (!a) return bad(res, "not found", 404);
  res.json(a);
});
api.delete("/agents/:id", (req, res) => {
  res.json({ ok: deleteAgent(num(req.params.id, 0)) });
});

/* ---------- runs & events ---------- */

api.get("/runs", (req, res) => {
  res.json(
    listRuns({
      limit: num(req.query.limit, 50),
      agent_id: req.query.agent_id ? num(req.query.agent_id, 0) : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      platform: typeof req.query.platform === "string" ? req.query.platform : undefined,
    }),
  );
});
api.get("/events", (req, res) => {
  res.json(listEvents({ limit: num(req.query.limit, 50), unread: req.query.unread === "1", platform: typeof req.query.platform === "string" ? req.query.platform : undefined }));
});
api.post("/events/:id/read", (req, res) => res.json({ ok: markEventRead(num(req.params.id, 0), req.body?.read !== false) }));
api.post("/events/read-all", (_req, res) => res.json({ ok: true, changed: markAllEventsRead() }));

/* ---------- platforms ---------- */

api.get("/platforms", (_req, res) => {
  const platforms = getPlatforms();
  res.json(Object.values(platforms).map((p) => ({ ...p, state: getPlatformState(p.id), actions: availableActions(p) })));
});
api.get("/platforms/:id", (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown platform", 404);
  const s = getPlatformState(p.id);
  let meta: unknown = null;
  try {
    meta = s.meta ? JSON.parse(s.meta) : null;
  } catch {
    meta = null;
  }
  res.json({ ...p, state: { ...s, meta }, actions: availableActions(p), captures: listCaptures(p.id, 50) });
});
const platformPatch = z
  .object({
    name: z.string().max(80),
    appUrl: z.string().max(2000),
    tasksUrl: z.string().max(2000),
    capturePatterns: z.array(z.string().max(300)).max(30),
    loginUrlPatterns: z.array(z.string().max(300)).max(30),
    sessionCookie: z.string().max(120),
    cookieDomain: z.string().max(120),
    loggedInSelector: z.string().max(300),
    loggedOutSelector: z.string().max(300),
    nativeUrlTemplate: z.string().max(2000),
    snapshotSelector: z.string().max(300),
    notes: z.string().max(2000),
    actions: z.record(
      z.string(),
      z.object({
        label: z.string().max(80).optional(),
        description: z.string().max(300).optional(),
        steps: z.array(
          z.object({
            type: z.enum(["goto", "click", "fill", "press", "wait", "waitFor"]),
            url: z.string().optional(),
            selector: z.string().optional(),
            value: z.string().optional(),
            key: z.string().optional(),
            ms: z.number().optional(),
          }),
        ),
      }),
    ),
  })
  .partial();
api.put("/platforms/:id", (req, res) => {
  const id = req.params.id.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!id) return bad(res, "invalid id");
  const parsed = platformPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid platform config", issues: parsed.error.issues });
  res.json(savePlatformOverride(id, parsed.data));
});
api.delete("/platforms/:id/overrides", (req, res) => {
  deletePlatformOverride(req.params.id);
  res.json({ ok: true });
});
api.get("/platforms/:id/screenshot.png", (req, res) => {
  const s = getPlatformState(req.params.id);
  if (!s.screenshot_path || !fs.existsSync(s.screenshot_path)) return bad(res, "no screenshot yet", 404);
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(s.screenshot_path);
});
api.get("/platforms/:id/captures", (req, res) => res.json(listCaptures(req.params.id, num(req.query.limit, 100))));
api.get("/captures/:id", (req, res) => {
  const c = getCapture(num(req.params.id, 0));
  if (!c) return bad(res, "not found", 404);
  let json: unknown = undefined;
  try {
    json = JSON.parse(c.body);
  } catch {
    json = undefined;
  }
  res.json({ ...c, json });
});

/* ---------- sync & actions ---------- */

api.post("/sync", async (req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  if (isSyncRunning()) return bad(res, "a sync is already running", 409);
  const ids = Array.isArray(req.body?.platforms) ? (req.body.platforms as string[]) : undefined;
  res.json({ ok: true, results: await syncAll(ids) });
});
api.post("/platforms/:id/sync", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown platform", 404);
  if (!p.tasksUrl) return bad(res, "platform has no tasksUrl", 409);
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  res.json(await syncPlatform(p));
});
api.post("/platforms/:id/actions/:action", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown platform", 404);
  const agent = req.body?.agent_id ? getAgent(num(req.body.agent_id, 0)) : undefined;
  res.json(await runAction(p, req.params.action, agent));
});
api.get("/sync/log", (_req, res) => res.json(recentSyncLogs(50)));

/* ---------- browser ---------- */

api.get("/browser", async (_req, res) => {
  const domains = Object.values(getPlatforms())
    .map((p) => p.cookieDomain)
    .filter(Boolean);
  res.json({ ...(await browser.status()), vnc: { connections: vncState.connections }, storage: storageInfo(), cookies: await browser.cookieCounts(domains) });
});
api.post("/browser/backup", async (_req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  res.json({ ok: true, cookies: await browser.backupSessions(), storage: storageInfo() });
});
api.post("/browser/import-state", async (req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : [];
  if (!cookies.length) return bad(res, "body must be a Playwright storageState with a cookies array");
  res.json({ ok: true, imported: await browser.importState({ cookies }) });
});
api.get("/browser/export-state", async (_req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  res.json(await browser.exportState());
});
api.post("/browser/open", async (req, res) => {
  const platform = typeof req.body?.platform === "string" ? req.body.platform : "";
  const p = getPlatform(platform);
  if (!p) return bad(res, "unknown platform", 404);
  const url = typeof req.body?.url === "string" && /^https?:\/\//.test(req.body.url) ? req.body.url : p.tasksUrl || p.appUrl;
  if (!url) return bad(res, "no url");
  await browser.withLock(() => browser.consolePage(p.id, url), { label: `Opening ${p.name}`, platform: p.id });
  res.json({ ok: true, url });
});

/* ---------- email ---------- */

api.post("/email/poll", async (_req, res) => {
  try {
    res.json({ ok: true, ingested: await pollOnce() });
  } catch (err) {
    bad(res, err instanceof Error ? err.message : String(err), 500);
  }
});

/* ---------- test alert ---------- */

api.post("/alerts/test", async (_req, res) => {
  const sent = await sendAlert({ key: "test", title: "AI Control Plane test alert", body: "Alerts are wired up.", force: true });
  res.json({ ok: true, sent, configured: alertsConfigured() });
});
