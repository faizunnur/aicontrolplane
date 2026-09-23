import fs from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { availableActions, runAction } from "../actions.js";
import { ensureTaskAgent } from "../agents.js";
import { alertsConfigured, sendAlert } from "../alerts.js";
import { approvalMode, decide, decideForMessage, listPolicies, pendingApprovals, requestExternalApproval, setApprovalMode, setPolicy } from "../policy.js";
import { liveViewers } from "../browser/live.js";
import { browser, storageInfo, vncState } from "../browser/manager.js";
import { config } from "../config.js";
import {
  addAudit,
  addEvent,
  allPlatformStates,
  db,
  conversationMessages,
  createConversation,
  createMessage,
  deleteAgentProfile,
  deleteTask,
  deleteConversation,
  deleteMessage,
  findTask,
  getAgentProfile,
  getTask,
  getCapture,
  foldSteps,
  getApproval,
  getConversation,
  getMessage,
  getPlatformState,
  getRun,
  runEvents,
  inboxFor,
  listAgentProfiles,
  listApprovals,
  listAudit,
  listTasks,
  listCaptures,
  listConversations,
  listEvents,
  listMessages,
  listRuns,
  markAllEventsRead,
  markEventRead,
  openMessageCount,
  overviewCounts,
  recentStatusesByTask,
  recentSyncLogs,
  recordRun,
  runStats,
  schemaVersion,
  setSetting,
  updateAgentProfile,
  updateTask,
  updateConversation,
  updateMessage,
  upsertAgentProfile,
  upsertTask,
} from "../db.js";
import { deliverMessage } from "../deliver.js";
import { streamClients, streamHandler } from "../live.js";
import { routeMessage } from "../router.js";
import { handleControl } from "../answers.js";
import { classifyIntent } from "../intents.js";
import { activity, overview } from "../overview.js";
import { beginRun, endRun, requestCancel, runForMessage, RunTracker } from "../runs.js";
import { listTaskViews, startTask, taskView } from "../tasks.js";
import { connectionCard, expandMessage } from "../view.js";
import { emailStatus, pollOnce } from "../ingest/email.js";
import { deletePlatformOverride, getPlatform, getPlatforms, savePlatformOverride, visiblePlatforms } from "../platforms.js";
import {
  adminFromEnv,
  changeAdminPassword,
  clearSessionCookieHeader,
  clientIp,
  createAdminPassword,
  createSession,
  ingestToken,
  requireAdmin,
  requireIngest,
  revokeSession,
  rotateIngestToken,
  sessionCookieHeader,
  setupRequired,
  verifyAdmin,
} from "../auth.js";
import { rateLimit } from "../ratelimit.js";
import { isSyncRunning, schedulerStatus, syncAll, syncProvider } from "../sync.js";
import { deliverToConnection } from "../deliver.js";
import { getProvider, listProviders, providerView, requireProvider } from "../providers/registry.js";
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
  updateMessage(messageId, { task_id: agentId, status: "assigned", error: null, delivered_at: null, acked_at: null });
  return expandMessage(await deliverMessage(messageId));
}

function bad(res: Response, msg: string, code = 400) {
  res.status(code).json({ error: msg });
}
/** Attach the provider's own id to a run an agent opened, so a later report with the same id updates it. */
function finishRunExternalId(runId: number, externalId: string) {
  const run = getRun(runId);
  if (run) finishRunExternal(run.id, externalId);
}
function finishRunExternal(runId: number, externalId: string) {
  db.prepare("UPDATE runs SET external_id = ? WHERE id = ?").run(externalId, runId);
}
function num(v: unknown, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function secure(req: Request) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/* ---------- auth & first run ---------- */

const loginLimit = rateLimit({ name: "login", max: 10, windowMs: 10 * 60_000 });
api.get("/setup", (_req, res) => res.json({ setupRequired: setupRequired(), passwordFromEnv: adminFromEnv() }));
api.post("/setup", loginLimit, (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < 8) return bad(res, "Use at least 8 characters.");
  if (!createAdminPassword(password)) return bad(res, "A password already exists. Sign in instead.", 409);
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req), createSession(req)));
  res.json({ ok: true });
});
api.post("/session", loginLimit, (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : typeof req.body?.password === "string" ? req.body.password : "";
  if (!verifyAdmin(token)) {
    addAudit({ actor: clientIp(req), action: "auth.login_failed" });
    return res.status(401).json({ error: "That password was not accepted.", setup: setupRequired() });
  }
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req), createSession(req)));
  res.json({ ok: true });
});
api.delete("/session", (req, res) => {
  revokeSession(req);
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
  /** Which agent carries the task out. Absent: the provider's assistant, or a profile of the task's own for custom agents. */
  profile: z
    .object({
      key: z.string().min(1).max(200),
      name: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      capabilities: z.array(z.string().max(60)).max(50).optional(),
    })
    .optional(),
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
  const { agent: a, profile, run, event } = parsed.data;
  const platform = a.platform.toLowerCase();
  const agent = upsertTask({
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
  const agentProfile = ensureTaskAgent(agent, profile ?? null);
  let runRow = null;
  if (run) {
    const r = recordRun({
      task_id: agent.id,
      kind: "external",
      provider: platform,
      trigger: "push",
      label: agent.name,
      agent_id: agentProfile?.id ?? null,
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
  res.json({ ok: true, agent, task: agent, profile: agentProfile, run: runRow, event: eventRow });
});

/* ---------- runs reported live by your own agents (ingest token) ---------- */

const openRunSchema = z.object({
  agent: z.object({ key: z.string().min(1).max(200), platform: z.string().min(1).max(50).default("custom"), name: z.string().max(200).optional() }),
  profile: z.object({ key: z.string().min(1).max(200), name: z.string().max(200).optional() }).optional(),
  label: z.string().max(200).optional(),
  external_id: z.string().max(200).optional(),
});
/** An agent says "I am starting this now". The run appears running in the control plane until it is finished. */
api.post("/runs", requireIngest, (req, res) => {
  const parsed = openRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid run", issues: parsed.error.issues });
  const d = parsed.data;
  const platform = d.agent.platform.toLowerCase();
  const task = upsertTask({ platform, key: d.agent.key, name: d.agent.name, source: "push" });
  const agent = ensureTaskAgent(task, d.profile ?? null);
  const { run } = beginRun({ kind: "external", label: d.label ?? task.name, provider: platform, task_id: task.id, agent_id: agent?.id ?? null, trigger: "push", source: "push" });
  if (d.external_id) finishRunExternalId(run.id, d.external_id);
  res.json({ ok: true, run: getRun(run.id), events_url: `/api/runs/${run.id}/events`, finish_url: `/api/runs/${run.id}/finish` });
});
const runEventSchema = z.object({
  type: z.enum(["step", "log"]).default("step"),
  key: z.string().max(60).optional(),
  label: z.string().min(1).max(300),
  status: z.enum(["pending", "running", "done", "failed", "skipped", "waiting"]).optional(),
  detail: z.string().max(2000).optional(),
});
/** A line in a running run's timeline: "researching", "approval requested", "drafting the report". */
api.post("/runs/:id/events", requireIngest, (req, res) => {
  const run = getRun(num(req.params.id, 0));
  if (!run) return bad(res, "not found", 404);
  if (run.status !== "running") return bad(res, "that run is finished", 409);
  const parsed = runEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid event", issues: parsed.error.issues });
  const d = parsed.data;
  const track = new RunTracker(run.id, run.message_id);
  if (d.type === "log") track.log(d.label, d.detail ?? null);
  else track.set(d.key ?? d.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60), d.label, d.status ?? "running", d.detail ?? null);
  res.json({ ok: true, steps: track.read() });
});
const finishSchema = z.object({
  status: z.enum(["success", "failed", "needs_attention", "cancelled"]).default("success"),
  summary: z.string().max(4000).optional(),
  error: z.string().max(4000).optional(),
  output_url: z.string().max(2000).optional(),
});
api.post("/runs/:id/finish", requireIngest, (req, res) => {
  const run = getRun(num(req.params.id, 0));
  if (!run) return bad(res, "not found", 404);
  if (run.status !== "running") return bad(res, "that run is already finished", 409);
  const parsed = finishSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid outcome", issues: parsed.error.issues });
  const d = parsed.data;
  const track = new RunTracker(run.id, run.message_id);
  for (const s of track.read()) if (s.status === "waiting" || s.status === "running") track.set(s.key, s.label, d.status === "success" ? "done" : "failed", d.summary ?? d.error ?? null);
  const done = endRun(run.id, { status: d.status, summary: d.summary ?? null, error: d.error ?? null, output_url: d.output_url ?? null })!;
  if (d.status === "failed" || d.status === "needs_attention") {
    addEvent({ platform: run.provider, kind: "run", title: `${run.label ?? "A run"}: ${d.status.replace("_", " ")}`, body: d.summary ?? d.error ?? null, link: d.output_url ?? null, dedupe_key: `run_finish:${run.id}` });
    void sendAlert({ key: `run:${run.task_id ?? run.id}`, title: `${run.label ?? "Run"} ${d.status}`, body: d.summary ?? d.error, link: d.output_url });
  }
  res.json({ ok: true, run: done });
});

/* ---------- agent self-registration (ingest token) ---------- */

const registerSchema = z.object({
  key: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string().max(60)).max(50).optional(),
  /** Provider id the agent runs on; defaults to "custom". */
  provider: z.string().max(50).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
});
/* ---------- approvals requested by your own agents (ingest token) ---------- */

const approvalRequestSchema = z.object({
  action: z.string().min(1).max(60),
  summary: z.string().min(1).max(500),
  detail: z.string().max(4000).optional(),
  provider: z.string().max(50).optional(),
  run_id: z.number().int().optional(),
});
/** "May I deploy?" The answer follows the policy for that action; the agent polls the approval until it is decided. */
api.post("/approvals/request", requireIngest, (req, res) => {
  const parsed = approvalRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid approval request", issues: parsed.error.issues });
  const r = requestExternalApproval({ ...parsed.data, provider: parsed.data.provider ?? "custom" });
  res.json({ ok: true, decision: r.decision, approval: r.approval, poll_url: `/api/approvals/${r.approval.id}` });
});
api.get("/approvals/:id", requireIngest, (req, res) => {
  const a = getApproval(num(req.params.id, 0));
  if (!a) return bad(res, "not found", 404);
  res.json(a);
});

/** A program of your own announces itself. It appears in the control plane next to ChatGPT, Claude and Grok. */
api.post("/agents/register", requireIngest, (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const d = parsed.data;
  const profile = upsertAgentProfile({ key: d.key, name: d.name, description: d.description ?? null, capabilities: d.capabilities ?? null, provider_id: (d.provider ?? "custom").toLowerCase(), kind: "custom", configuration: d.configuration });
  res.json({ ok: true, agent: profile });
});

/* ---------- inbox (agents pull their instructions; ingest token) ---------- */

api.get("/inbox", requireIngest, (req, res) => {
  const platform = String(req.query.platform ?? "").toLowerCase();
  const key = String(req.query.key ?? "");
  if (!platform || !key) return bad(res, "platform and key are required");
  const agent = findTask(platform, key);
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
  // The agent reporting back closes the dispatch run that carried the instruction.
  if (updated.run_id && parsed.data.status !== "acknowledged") {
    endRun(updated.run_id, { status: parsed.data.status === "failed" ? "failed" : "success", summary: parsed.data.response ?? null, error: parsed.data.status === "failed" ? (parsed.data.response ?? "agent reported failure") : null });
  }
  if (parsed.data.status === "failed") {
    addEvent({
      platform: updated.task_platform,
      kind: "message",
      title: `${updated.task_name ?? "Agent"} could not complete an instruction`,
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

/* providers: execution backends with declared capabilities */
api.get("/providers", (_req, res) => res.json(listProviders().map(providerView)));
api.get("/providers/:id", (req, res) => {
  const a = getProvider(req.params.id);
  if (!a) return bad(res, "unknown provider", 404);
  res.json(providerView(a));
});

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
/* ---------- signing in ----------
   live:    the provider's site opens in its automated tab and the live view shows it.
   desktop: the automation steps aside and a plain browser window opens on the cloud display
            (shown through the desktop view) for sites whose sign-in page has a bot check. */

const VNC_PATH = "/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify&reconnect=1";
let vncProbe: { at: number; ok: boolean } | null = null;
/** Is the desktop view (noVNC bridge) reachable? Probed at most every 30 seconds. */
async function vncAvailable(): Promise<boolean> {
  if (vncProbe && Date.now() - vncProbe.at < 30_000) return vncProbe.ok;
  let ok = false;
  try {
    const r = await fetch(config.vnc.target + "/vnc.html", { method: "HEAD", signal: AbortSignal.timeout(800) });
    ok = r.ok;
  } catch {
    ok = false;
  }
  vncProbe = { at: Date.now(), ok };
  return ok;
}
const signInOptions = async (a: ReturnType<typeof requireProvider>) => ({ preferred: a.preferredSignIn(), desktop: browser.canDesktopSignIn(), vnc: { available: await vncAvailable(), url: VNC_PATH } });

/** Bring the AI's sign-in page up in its tab; the live view then shows that tab for the user to sign in. */
api.post("/connections/:id/connect", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    if (!browser.enabled) return bad(res, "the browser is disabled on this deployment", 409);
    const found = await a.connect();
    if (found.blocked) addAudit({ actor: "system", action: "signin.blocked", target: a.id, detail: found.challenge });
    res.json({ ok: true, platform: a.id, mode: "live", ...found, ...(await signInOptions(a)), screen: VNC_PATH });
  } catch (err) {
    next(err);
  }
});
/** Desktop sign-in: open a plain browser window on the cloud display with the provider's site. */
api.post("/connections/:id/signin", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    if (!a.supports("signIn")) throw a.unsupported("signIn");
    const c = a.config();
    const signIn = await browser.startDesktopSignIn(c.id, c.name, c.appUrl);
    addAudit({ actor: "you", action: "signin.desktop_started", target: a.id });
    res.json({ ok: true, platform: a.id, mode: "desktop", signIn, ...(await signInOptions(a)) });
  } catch (err) {
    next(err);
  }
});
/** The user pressed "I'm signed in": close the plain window, hand the profile back, and check. */
api.post("/connections/:id/signin/finish", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    const wasDesktop = await browser.finishDesktopSignIn();
    const status = await a.checkAuth();
    if (status === "logged_in") {
      if (wasDesktop) setSetting(`signin_mode:${a.id}`, "desktop");
      addAudit({ actor: "you", action: "signin.completed", target: a.id, detail: wasDesktop ? "desktop" : "live" });
    }
    res.json({ ...connectionCard(a.config()), status, mode: wasDesktop ? "desktop" : "live" });
  } catch (err) {
    next(err);
  }
});
api.post("/connections/:id/signin/cancel", async (req, res, next) => {
  try {
    requireProvider(req.params.id);
    res.json({ ok: await browser.cancelDesktopSignIn() });
  } catch (err) {
    next(err);
  }
});
/** After signing in: confirm the session and capture a screenshot. */
api.post("/connections/:id/check", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    const status = await a.checkAuth();
    res.json({ ...connectionCard(a.config()), status });
  } catch (err) {
    next(err);
  }
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
  // Questions about the control plane and commands about tasks are answered here; they never reach a provider.
  if (!chosen) {
    const intent = await classifyIntent(text);
    if (intent.kind !== "chat") {
      await handleControl(intent, msg.id);
      return res.json({ message: expandMessage(getMessage(msg.id)!), routed: "control", intent, conversation: getConversation(conversation.id) });
    }
  }
  if (chosen) {
    updateMessage(msg.id, { routing: { method: "manual", confidence: 1, reason: "You chose it." } });
    // Respond right away; the reply lands in the thread when the AI answers.
    res.json({ message: expandMessage(getMessage(msg.id)!), routed: chosen, conversation: getConversation(conversation.id) });
    void deliverToConnection(msg.id, chosen);
    return;
  }
  const routing = await routeToConnection(text);
  updateMessage(msg.id, {
    suggestions: routing.options,
    routing: { method: routing.method, confidence: routing.top?.confidence ?? 0, reason: routing.reason, llm_error: routing.llm_error },
  });
  if (routing.top && routing.top.confidence >= config.router.autoThreshold) {
    res.json({ message: expandMessage(getMessage(msg.id)!), routed: routing.top.platform, conversation: getConversation(conversation.id) });
    void deliverToConnection(msg.id, routing.top.platform);
    return;
  }
  res.json({ message: expandMessage(getMessage(msg.id)!), routed: null, conversation: getConversation(conversation.id) });
});
api.post("/chat/:id/send", async (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const platform = String(req.body?.platform ?? "");
  const p = getPlatform(platform);
  if (!p) return bad(res, "unknown AI", 404);
  updateMessage(m.id, { routing: { method: "manual", confidence: 1, reason: "You chose it." } });
  res.json({ ok: true });
  void deliverToConnection(m.id, platform);
});
/** Manual mode: the agent paused before an action and waits for this. */
api.post("/chat/:id/approve", (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const decision = req.body?.decision === "reject" || req.body?.decision === "rejected" ? "rejected" : "approved";
  const row = decideForMessage(m.id, decision);
  if (!row) return bad(res, "nothing is waiting for approval on this message", 409);
  res.json({ ok: true, decision, approval: row });
});
/** Stop a task that is running. If the message was already sent, only the wait is stopped. */
api.post("/chat/:id/cancel", (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  if (!["assigned", "delivered"].includes(m.status)) return bad(res, "nothing is running for this message", 409);
  const run = runForMessage(m.id);
  if (run) requestCancel(run.id);
  decideForMessage(m.id, "rejected");
  res.json({ ok: true, run_id: run?.id ?? null });
});
api.delete("/chat/:id", (req, res) => res.json({ ok: deleteMessage(num(req.params.id, 0)) }));

/* execution mode: auto (the agent acts on its own) or manual (it asks before acting) — a preset over the policies */
const approvalView = (a: ReturnType<typeof pendingApprovals>[number]) => ({ ...a, messageId: a.message_id, runId: a.run_id });
api.get("/settings/approval", (_req, res) => res.json({ approvalMode: approvalMode(), pending: pendingApprovals().map(approvalView) }));
api.put("/settings/approval", (req, res) => {
  const mode = req.body?.approvalMode === "manual" ? "manual" : req.body?.approvalMode === "auto" ? "auto" : null;
  if (!mode) return bad(res, "approvalMode must be auto or manual");
  setApprovalMode(mode);
  res.json({ approvalMode: mode });
});

/* approvals: everything waiting for you, and what was decided */
api.get("/approvals", (req, res) => {
  res.json({ pending: pendingApprovals().map(approvalView), recent: listApprovals({ status: ["approved", "rejected", "expired", "interrupted"], limit: num(req.query.limit, 30) }).map(approvalView) });
});
api.post("/approvals/:id/decide", (req, res) => {
  const decision = req.body?.decision === "reject" || req.body?.decision === "rejected" ? "rejected" : req.body?.decision === "approve" || req.body?.decision === "approved" ? "approved" : null;
  if (!decision) return bad(res, "decision must be approve or reject");
  const row = decide(num(req.params.id, 0), decision, "you", typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null);
  if (!row) return bad(res, "that approval is not pending", 409);
  res.json({ ok: true, approval: approvalView(row) });
});

/* policies: which actions go ahead and which ask */
api.get("/policies", (_req, res) => res.json(listPolicies()));
api.put("/policies/:action", (req, res, next) => {
  try {
    const mode = req.body?.mode;
    if (mode !== null && mode !== "auto" && mode !== "ask" && mode !== "always") return bad(res, "mode must be auto, ask, always or null");
    res.json(setPolicy(req.params.action.slice(0, 60), mode));
  } catch (err) {
    next(err);
  }
});

/* one call for the whole app */
api.get("/home", async (req, res) => {
  const connections = visiblePlatforms().map(connectionCard);
  const conversations = listConversations();
  const wanted = num(req.query.conversation_id, 0);
  const current = (wanted ? getConversation(wanted) : undefined) ?? conversations[0] ?? null;
  const runs = listRuns({ limit: 15 }).map((r) => ({ kind: "run", at: r.finished_at || r.started_at || r.created_at, platform: r.provider, title: r.label ?? r.task_name ?? r.kind, status: r.status, summary: r.summary, link: r.output_url || r.task_native_url, run_id: r.id, run_kind: r.kind }));
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
    approvals: pendingApprovals().map(approvalView),
    agents: listAgentProfiles(),
    overview: overview(),
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
  // Every other browser is signed out; this one continues on a fresh session.
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req), createSession(req)));
  res.json({ ok: true });
});
/** Who did what: logins, approvals, policy changes, exports, live-view control. */
api.get("/audit", (req, res) => res.json(listAudit({ limit: num(req.query.limit, 100), action: typeof req.query.action === "string" ? req.query.action : undefined })));
api.post("/settings/ingest-token/rotate", (_req, res) => res.json({ ingestToken: rotateIngestToken(), fromEnv: !!process.env.ACP_INGEST_TOKEN }));

/* ---------- messages (instructions from you, routed to agents) ---------- */

api.get("/messages", (req, res) => {
  res.json(
    listMessages({
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      task_id: req.query.task_id ? num(req.query.task_id, 0) : undefined,
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

  if (req.body?.task_id || req.body?.agent_id) {
    const agent = getTask(num(req.body.task_id ?? req.body.agent_id, 0));
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
    return res.json({ message: await assignAndDeliver(msg.id, routing.top.task_id), auto_assigned: true });
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
  const agent = getTask(num(req.body?.task_id ?? req.body?.agent_id, 0));
  if (!agent) return bad(res, "unknown task", 404);
  res.json(await assignAndDeliver(m.id, agent.id));
});
api.post("/messages/:id/retry", async (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  if (!m.task_id) return bad(res, "message has no agent; assign it first", 409);
  res.json(await assignAndDeliver(m.id, m.task_id));
});
api.post("/messages/:id/reroute", async (req, res) => {
  const m = getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const routing = await routeMessage(m.text);
  const updated = updateMessage(m.id, {
    status: "needs_assignment",
    task_id: null,
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
  const updated = updateMessage(m.id, { status: status as "done", acked_at: new Date().toISOString(), response })!;
  if (updated.run_id && (status === "done" || status === "failed")) endRun(updated.run_id, { status: status === "done" ? "success" : "failed", summary: response ?? null });
  res.json(expandMessage(updated));
});
api.delete("/messages/:id", (req, res) => res.json({ ok: deleteMessage(num(req.params.id, 0)) }));

/* what is running, scheduled, finished, failed, and what needs you: real rows only */
api.get("/overview", (_req, res) => res.json(overview()));
/** The unified activity feed: every timeline line across every run, newest first. */
api.get("/activity", (req, res) => {
  res.json(activity({ limit: num(req.query.limit, 100), provider: typeof req.query.provider === "string" ? req.query.provider : undefined, agent_id: req.query.agent_id ? num(req.query.agent_id, 0) : undefined, run_id: req.query.run_id ? num(req.query.run_id, 0) : undefined }));
});
/** Provider diagnostics for developers: state, captured payloads, actions. */
api.get("/diagnostics", async (_req, res) => {
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
    return { id: p.id, name: p.name, syncable: !!p.tasksUrl, state: { ...s, meta: { finalUrl: meta.finalUrl, title: meta.title, snapshotAt: meta.snapshotAt } }, hasScreenshot: !!(s.screenshot_path && fs.existsSync(s.screenshot_path)), tasks: listTasks({ platform: p.id }).length, actions: availableActions(p) };
  });
  res.json({ counts: { ...overviewCounts(), openMessages: openMessageCount() }, platforms: cards, router: { llm: config.router.llm, provider: config.router.provider, model: config.router.model, autoThreshold: config.router.autoThreshold }, storage: storageInfo(), scheduler: schedulerStatus(), browser: await browser.status(), email: emailStatus(), alerts: { configured: alertsConfigured() }, publicUrl: config.publicUrl, schema: schemaVersion() });
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

/* ---------- the task registry: every standing piece of work, every provider, one shape ---------- */

api.get("/tasks", (req, res) => {
  res.json(listTaskViews({ platform: typeof req.query.platform === "string" ? req.query.platform : undefined, agent_id: req.query.agent_id ? num(req.query.agent_id, 0) : undefined, includeDisabled: req.query.all === "1" }));
});
api.get("/tasks/:id", (req, res) => {
  const t = listTasks({ includeDisabled: true }).find((x) => x.id === num(req.params.id, 0));
  if (!t) return bad(res, "not found", 404);
  res.json({ ...taskView(t, recentStatusesByTask(10)), runs: listRuns({ task_id: t.id, limit: 20 }) });
});
api.post("/tasks", (req, res) => {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid task", issues: parsed.error.issues });
  const d = parsed.data;
  const key = d.key || d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `task-${Date.now()}`;
  const task = upsertTask({ ...d, key, platform: d.platform.toLowerCase(), source: "registry" });
  ensureTaskAgent(task);
  res.json(taskView({ ...getTask(task.id)!, last_run: null }));
});
const taskPatch = agentSchema.partial().extend({ prompt: z.string().max(20_000).nullable().optional(), configuration: z.record(z.string(), z.unknown()).nullable().optional() });
const patchTask = (req: Request, res: Response) => {
  const parsed = taskPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid task", issues: parsed.error.issues });
  const t = updateTask(num(req.params.id, 0), parsed.data);
  if (!t) return bad(res, "not found", 404);
  addAudit({ actor: "you", action: parsed.data.enabled === false ? "task.paused" : parsed.data.enabled === true ? "task.resumed" : "task.updated", target: `task:${t.id}`, detail: t.name });
  res.json(taskView({ ...t, last_run: listRuns({ task_id: t.id, limit: 1 })[0] ?? null }));
};
api.put("/tasks/:id", patchTask);
api.patch("/tasks/:id", patchTask);
api.delete("/tasks/:id", (req, res) => {
  res.json({ ok: deleteTask(num(req.params.id, 0)) });
});
/** Start a task now, where the provider allows it. Goes through the run_task policy. */
api.post("/tasks/:id/run", async (req, res, next) => {
  try {
    addAudit({ actor: "you", action: "task.run_requested", target: `task:${req.params.id}` });
    const run = await startTask(num(req.params.id, 0), { text: typeof req.body?.text === "string" ? req.body.text.slice(0, 20_000) : undefined, trigger: "user" });
    res.json({ ok: run.status !== "failed", run: { ...run, events: runEvents(run.id), steps: foldSteps(runEvents(run.id)) } });
  } catch (err) {
    next(err);
  }
});

/* ---------- stats ---------- */

api.get("/stats/runs", (req, res) => res.json(runStats(num(req.query.days, 14))));

/* ---------- agent profiles (who does the work) ---------- */

api.get("/agents", (req, res) => {
  res.json(listAgentProfiles({ provider: typeof req.query.provider === "string" ? req.query.provider : undefined, kind: typeof req.query.kind === "string" ? req.query.kind : undefined, includeDisabled: req.query.all === "1" }));
});
api.get("/agents/:id", (req, res) => {
  const a = getAgentProfile(num(req.params.id, 0));
  if (!a) return bad(res, "not found", 404);
  res.json({ ...a, tasks: listTasks({ agent_id: a.id }), runs: listRuns({ agent_id: a.id, limit: 20 }) });
});
const profilePatch = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable(),
    status: z.enum(["active", "paused", "disabled"]),
    capabilities: z.array(z.string().max(60)).max(50).nullable(),
    configuration: z.record(z.string(), z.unknown()).nullable(),
  })
  .partial();
api.post("/agents", (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const d = parsed.data;
  res.json(upsertAgentProfile({ key: d.key, name: d.name, description: d.description ?? null, capabilities: d.capabilities ?? null, provider_id: (d.provider ?? "custom").toLowerCase(), kind: "custom", configuration: d.configuration }));
});
api.patch("/agents/:id", (req, res) => {
  const parsed = profilePatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const a = updateAgentProfile(num(req.params.id, 0), parsed.data);
  if (!a) return bad(res, "not found", 404);
  res.json(a);
});
api.delete("/agents/:id", (req, res) => {
  const a = getAgentProfile(num(req.params.id, 0));
  if (!a) return bad(res, "not found", 404);
  if (a.kind !== "custom") return bad(res, "only your own agents can be removed; assistants belong to their provider", 409);
  res.json({ ok: deleteAgentProfile(a.id) });
});

/* ---------- runs & events ---------- */

api.get("/runs", (req, res) => {
  res.json(
    listRuns({
      limit: num(req.query.limit, 50),
      task_id: req.query.task_id ?? req.query.agent_id ? num(req.query.task_id ?? req.query.agent_id, 0) : undefined,
      status: typeof req.query.status === "string" ? req.query.status.split(",") : undefined,
      platform: typeof req.query.platform === "string" ? req.query.platform : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
    }),
  );
});
/** One run with its timeline: the raw events and the step view folded from them. */
api.get("/runs/:id", (req, res) => {
  const run = getRun(num(req.params.id, 0));
  if (!run) return bad(res, "not found", 404);
  const events = runEvents(run.id);
  res.json({ ...run, events, steps: foldSteps(events) });
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
api.post("/platforms/:id/sync", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    if (!a.supports("listTasks")) throw a.unsupported("listTasks");
    if (!browser.enabled) return bad(res, "browser is disabled", 409);
    res.json(await syncProvider(a));
  } catch (err) {
    next(err);
  }
});
api.post("/platforms/:id/actions/:action", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown platform", 404);
  const task = req.body?.task_id || req.body?.agent_id ? getTask(num(req.body.task_id ?? req.body.agent_id, 0)) : undefined;
  res.json(await runAction(p, req.params.action, task, {}, { trigger: "user" }));
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
  addAudit({ actor: "you", action: "browser.import_state", detail: `${cookies.length} cookies from ${clientIp(req)}` });
  res.json({ ok: true, imported: await browser.importState({ cookies }) });
});
api.get("/browser/export-state", async (req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  // Cookies for every signed-in provider leave the server here; that is always worth a record.
  addAudit({ actor: "you", action: "browser.export_state", detail: clientIp(req) });
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
