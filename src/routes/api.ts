import fs from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { availableActions } from "../actions.js";
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
  conversationMessages,
  countUsers,
  createUser,
  deleteSessionsForUser,
  deleteUser,
  getUser,
  getUserByEmail,
  listUsers,
  updateUser,
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
  type PairingRow,
  recentStatusesByTask,
  recentSyncLogs,
  recordRun,
  runStats,
  schemaVersion,
  setRunExternalId,
  setSetting,
  updateAgentProfile,
  updateTask,
  updateConversation,
  updateMessage,
  upsertAgentProfile,
  upsertTask,
} from "../db.js";
import { streamClients, streamHandler } from "../live.js";
import { routeMessage } from "../router.js";
import { handleControl } from "../answers.js";
import { classifyIntent } from "../intents.js";
import { logLevel, logScopes, recentLogs, setLogLevel, type Level } from "../logger.js";
import { activity, overview } from "../overview.js";
import { activePairing, cancelPairing, createPairing, exchangePairing, finishPairing, markImporting, requirePairingFor } from "../pairing.js";
import { selectProviderState, sessionDomains } from "../providers/browser/domains.js";
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
  crossOrigin,
  hashPassword,
  parseCookies,
  requireRole,
  SESSION_COOKIE,
  setupRequired,
  verifyUser,
  type AuthUser,
} from "../auth.js";
import { rateLimit } from "../ratelimit.js";
import { isSyncRunning, schedulerStatus } from "../sync.js";
import { resolveMode } from "../deliver.js";
import { JOB, queue, type ChatDeliverJob, type DispatchDeliverJob } from "../queue.js";
import { browserRuntimeAvailable, callBrowserOp, desktopState } from "../browser-ops.js";
import { getProvider, listProviders, providerView, requireProvider } from "../providers/registry.js";
import { connectedPlatforms, routeToConnection } from "../router.js";

export const api = Router();

// CSRF: a state-changing request that rides the session COOKIE must come from this app's own
// pages. Bearer-authenticated calls (agents, scripts, the pairing helper) carry no cookie and
// pass untouched; SameSite=Lax already blocks most vectors — this closes the rest.
api.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const hasCookie = !!parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!hasCookie) return next();
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "" && site !== "same-origin" && site !== "none") {
    return res.status(403).json({ error: "cross-site requests cannot use the session cookie" });
  }
  if (crossOrigin(req)) return res.status(403).json({ error: "cross-origin requests cannot use the session cookie" });
  next();
});

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
  await updateMessage(messageId, { task_id: agentId, status: "assigned", error: null, delivered_at: null, acked_at: null });
  // Delivery is a job: inline it completes before this returns; split it lands on a worker
  // and the thread follows over the stream. A browser-mode delivery goes to a browser-capable process.
  const task = await getTask(agentId);
  const jobName = task && resolveMode(task) === "browser" ? JOB.browserDispatchDeliver : JOB.dispatchDeliver;
  await queue.send<DispatchDeliverJob>(jobName, { messageId });
  return await expandMessage((await getMessage(messageId))!);
}

function bad(res: Response, msg: string, code = 400) {
  res.status(code).json({ error: msg });
}
/** Attach the provider's own id to a run an agent opened, so a later report with the same id updates it. */
async function finishRunExternalId(runId: number, externalId: string) {
  const run = await getRun(runId);
  if (run) await setRunExternalId(run.id, externalId);
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
api.get("/setup", async (_req, res) => res.json({ setupRequired: await setupRequired(), passwordFromEnv: adminFromEnv() }));
api.post("/setup", loginLimit, async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const email = typeof req.body?.email === "string" && req.body.email.includes("@") ? req.body.email.trim().toLowerCase().slice(0, 200) : undefined;
  if (password.length < 8) return bad(res, "Use at least 8 characters.");
  if (!await createAdminPassword(password, email)) return bad(res, "An account already exists. Sign in instead.", 409);
  const user = await verifyUser(password, email);
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req), await createSession(req, user)));
  res.json({ ok: true, user: user ? { email: user.email, role: user.role } : null });
});
api.post("/session", loginLimit, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : typeof req.body?.password === "string" ? req.body.password : "";
  const email = typeof req.body?.email === "string" && req.body.email ? req.body.email.trim().toLowerCase().slice(0, 200) : undefined;
  const user = await verifyUser(token, email);
  if (!user) {
    await addAudit({ actor: clientIp(req), action: "auth.login_failed", detail: email ?? null });
    const several = (await countUsers()) > 1 && !email;
    return res.status(401).json({ error: several ? "Several accounts exist here; sign in with your email and password." : "That password was not accepted.", setup: await setupRequired(), needsEmail: several });
  }
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req), await createSession(req, user)));
  res.json({ ok: true, user: { email: user.email, role: user.role } });
});
api.delete("/session", async (req, res) => {
  await revokeSession(req);
  res.setHeader("Set-Cookie", clearSessionCookieHeader());
  res.json({ ok: true });
});
api.get("/session", requireAdmin, (_req, res) => {
  const user = res.locals.user as AuthUser;
  res.json({ ok: true, admin: true, publicUrl: config.publicUrl, user: { email: user.email, role: user.role } });
});

/* ---------- signing in from your own computer ----------
   Some sign-in pages refuse any browser in a datacenter. The app hands out a short code; the helper on
   the user's computer trades it for a token good for one thing only: handing that one provider's
   session to the cloud browser. Neither route is admin: the helper has no password and no cookie. */

const pairingLimit = rateLimit({ name: "pairing", max: 10, windowMs: 10 * 60_000 });
api.post("/pairing/exchange", pairingLimit, async (req, res) => {
  if (!browserRuntimeAvailable()) return bad(res, "the browser is disabled on this deployment, so there is nowhere to put a sign-in", 409);
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const found = code ? await exchangePairing(code, clientIp(req)) : null;
  // One answer for unknown, expired and used codes alike: nothing to enumerate.
  if (!found) return bad(res, "That code is not valid or has expired. Make a new one in the app.", 404);
  const p = getPlatform(found.row.platform);
  if (!p) return bad(res, "That provider no longer exists.", 404);
  res.json({
    ok: true,
    token: found.token,
    expiresAt: found.row.expires_at,
    platform: { id: p.id, name: p.name, appUrl: p.appUrl, sessionCookie: p.sessionCookie, domains: sessionDomains(p), loginUrlPatterns: p.loginUrlPatterns },
    importPath: `/api/connections/${p.id}/import-session`,
  });
});
/** The helper hands over the session it captured; the server filters it again, imports it, and checks. */
api.post("/connections/:id/import-session", requirePairingFor, async (req, res, next) => {
  const pairing = res.locals.pairing as PairingRow | undefined;
  try {
    const a = requireProvider(String(req.params.id));
    if (!browserRuntimeAvailable()) return bad(res, "the browser is disabled on this deployment", 409);
    const p = a.config();
    const domains = sessionDomains(p);
    const picked = selectProviderState({ cookies: req.body?.cookies, origins: req.body?.origins }, domains);
    if (!picked.cookies.length) return bad(res, `no usable cookies for ${domains.join(", ")} were sent`);
    if (pairing) await markImporting(pairing.id);
    const { imported, status } = await callBrowserOp<{ imported: { cookies: number; origins: number; cleared: number }; status: string }>("session.import", { platformId: a.id, cookies: picked.cookies, origins: picked.origins }, 120_000);
    const h = req.body?.helper && typeof req.body.helper === "object" ? (req.body.helper as { version?: unknown; os?: unknown }) : null;
    const via = h ? ` via helper ${String(h.version ?? "?")} on ${String(h.os ?? "?")}` : "";
    if (status === "logged_in") {
      await setSetting(`signin_mode:${a.id}`, "local");
      await addAudit({ actor: clientIp(req), action: "signin.imported_from_computer", target: a.id, detail: `${imported.cookies} cookies, ${imported.origins} origin(s), ${imported.cleared} replaced${via}` });
      if (pairing) await finishPairing(pairing.id, "done", `${p.name} connected`);
    } else {
      await addAudit({ actor: clientIp(req), action: "signin.import_failed", target: a.id, detail: `${p.name} still looks signed out after importing ${imported.cookies} cookies${via}` });
      if (pairing) await finishPairing(pairing.id, "failed", `${p.name} still looks signed out after importing ${imported.cookies} cookies. Make sure you can see your chats in the Chrome window, then make a new code and try again.`);
    }
    res.json({ ok: status === "logged_in", status, name: p.name, imported, dropped: picked.dropped, mode: "local" });
  } catch (err) {
    // A refusal because the browser is held (a desktop sign-in) keeps the token: the helper retries.
    // Anything else ends the pairing with the reason, so the panel says what happened.
    const status = err && typeof err === "object" ? (err as { status?: number }).status : undefined;
    if (pairing && status !== 409) await finishPairing(pairing.id, "failed", err instanceof Error ? err.message : String(err));
    next(err);
  }
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
  const agent = await upsertTask({
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
  const agentProfile = await ensureTaskAgent(agent, profile ?? null);
  let runRow = null;
  if (run) {
    const r = await recordRun({
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
      await addEvent({
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
    eventRow = await addEvent({ platform, kind: event.kind, title: event.title, body: event.body ?? null, link: event.link ?? null });
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
api.post("/runs", requireIngest, async (req, res) => {
  const parsed = openRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid run", issues: parsed.error.issues });
  const d = parsed.data;
  const platform = d.agent.platform.toLowerCase();
  const task = await upsertTask({ platform, key: d.agent.key, name: d.agent.name, source: "push" });
  const agent = await ensureTaskAgent(task, d.profile ?? null);
  // The same Idempotency-Key opens the same run: an agent retrying a dropped response cannot double-open.
  const idem = req.header("idempotency-key")?.slice(0, 200) || null;
  const { run } = await beginRun({ kind: "external", label: d.label ?? task.name, provider: platform, task_id: task.id, agent_id: agent?.id ?? null, trigger: "push", source: "push", idempotency_key: idem });
  if (d.external_id) await finishRunExternalId(run.id, d.external_id);
  res.json({ ok: true, run: await getRun(run.id), events_url: `/api/runs/${run.id}/events`, finish_url: `/api/runs/${run.id}/finish` });
});
const runEventSchema = z.object({
  type: z.enum(["step", "log"]).default("step"),
  key: z.string().max(60).optional(),
  label: z.string().min(1).max(300),
  status: z.enum(["pending", "running", "done", "failed", "skipped", "waiting"]).optional(),
  detail: z.string().max(2000).optional(),
});
/** A line in a running run's timeline: "researching", "approval requested", "drafting the report". */
api.post("/runs/:id/events", requireIngest, async (req, res) => {
  const run = await getRun(num(req.params.id, 0));
  if (!run) return bad(res, "not found", 404);
  if (run.status !== "running") return bad(res, "that run is finished", 409);
  const parsed = runEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid event", issues: parsed.error.issues });
  const d = parsed.data;
  const track = new RunTracker(run.id, run.message_id);
  if (d.type === "log") await track.log(d.label, d.detail ?? null);
  else await track.set(d.key ?? d.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60), d.label, d.status ?? "running", d.detail ?? null);
  res.json({ ok: true, steps: await track.read() });
});
const finishSchema = z.object({
  status: z.enum(["success", "failed", "needs_attention", "cancelled"]).default("success"),
  summary: z.string().max(4000).optional(),
  error: z.string().max(4000).optional(),
  output_url: z.string().max(2000).optional(),
});
api.post("/runs/:id/finish", requireIngest, async (req, res) => {
  const run = await getRun(num(req.params.id, 0));
  if (!run) return bad(res, "not found", 404);
  if (run.status !== "running") return bad(res, "that run is already finished", 409);
  const parsed = finishSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid outcome", issues: parsed.error.issues });
  const d = parsed.data;
  const track = new RunTracker(run.id, run.message_id);
  for (const s of await track.read()) if (s.status === "waiting" || s.status === "running") await track.set(s.key, s.label, d.status === "success" ? "done" : "failed", d.summary ?? d.error ?? null);
  const done = (await endRun(run.id, { status: d.status, summary: d.summary ?? null, error: d.error ?? null, output_url: d.output_url ?? null }))!;
  if (d.status === "failed" || d.status === "needs_attention") {
    await addEvent({ platform: run.provider, kind: "run", title: `${run.label ?? "A run"}: ${d.status.replace("_", " ")}`, body: d.summary ?? d.error ?? null, link: d.output_url ?? null, dedupe_key: `run_finish:${run.id}` });
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
api.post("/approvals/request", requireIngest, async (req, res) => {
  const parsed = approvalRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid approval request", issues: parsed.error.issues });
  const r = await requestExternalApproval({ ...parsed.data, provider: parsed.data.provider ?? "custom" });
  res.json({ ok: true, decision: r.decision, approval: r.approval, poll_url: `/api/approvals/${r.approval.id}` });
});
api.get("/approvals/:id", requireIngest, async (req, res) => {
  const a = await getApproval(num(req.params.id, 0));
  if (!a) return bad(res, "not found", 404);
  res.json(a);
});

/** A program of your own announces itself. It appears in the control plane next to ChatGPT, Claude and Grok. */
api.post("/agents/register", requireIngest, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const d = parsed.data;
  const profile = await upsertAgentProfile({ key: d.key, name: d.name, description: d.description ?? null, capabilities: d.capabilities ?? null, provider_id: (d.provider ?? "custom").toLowerCase(), kind: "custom", configuration: d.configuration });
  res.json({ ok: true, agent: profile });
});

/* ---------- inbox (agents pull their instructions; ingest token) ---------- */

api.get("/inbox", requireIngest, async (req, res) => {
  const platform = String(req.query.platform ?? "").toLowerCase();
  const key = String(req.query.key ?? "");
  if (!platform || !key) return bad(res, "platform and key are required");
  const agent = await findTask(platform, key);
  if (!agent) return bad(res, "unknown agent", 404);
  const now = new Date().toISOString();
  const messages = (await inboxFor(agent.id)).map(async (m) => {
    if (m.status === "assigned") await updateMessage(m.id, { status: "delivered", delivered_at: now });
    return { id: m.id, text: m.text, created_at: m.created_at, ack_url: `/api/inbox/${m.id}/ack` };
  });
  res.json({ agent: { key: agent.key, name: agent.name, platform: agent.platform }, messages });
});

const ackSchema = z.object({
  status: z.enum(["acknowledged", "done", "failed"]).default("done"),
  response: z.string().max(20_000).optional(),
});
api.post("/inbox/:id/ack", requireIngest, async (req, res) => {
  const parsed = ackSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid ack", issues: parsed.error.issues });
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const updated = (await updateMessage(m.id, {
      status: parsed.data.status,
      acked_at: new Date().toISOString(),
      response: parsed.data.response ?? null,
      error: parsed.data.status === "failed" ? (parsed.data.response ?? "agent reported failure") : null,
    }))!;
  // The agent reporting back closes the dispatch run that carried the instruction.
  if (updated.run_id && parsed.data.status !== "acknowledged") {
    await endRun(updated.run_id, { status: parsed.data.status === "failed" ? "failed" : "success", summary: parsed.data.response ?? null, error: parsed.data.status === "failed" ? (parsed.data.response ?? "agent reported failure") : null });
  }
  if (parsed.data.status === "failed") {
    await addEvent({
            platform: updated.task_platform,
            kind: "message",
            title: `${updated.task_name ?? "Agent"} could not complete an instruction`,
            body: `${parsed.data.response ?? ""}\n\n"${updated.text.slice(0, 200)}"`,
            dedupe_key: `message_agent_failed:${updated.id}`,
          });
  }
  res.json({ ok: true, message: await expandMessage(updated) });
});

/* ---------- everything below is admin ---------- */

api.use(requireAdmin);

/* ---------- the app: connections, chat, home ---------- */

/** Live updates for the workspace (server-sent events). */
api.get("/stream", streamHandler);

/* providers: execution backends with declared capabilities */
api.get("/providers", async (_req, res) => res.json(await Promise.all(listProviders().map(providerView))));
api.get("/providers/:id", (req, res) => {
  const a = getProvider(req.params.id);
  if (!a) return bad(res, "unknown provider", 404);
  res.json(providerView(a));
});

api.get("/connections", async (_req, res) => res.json(await Promise.all(visiblePlatforms().map((p) => connectionCard(p)))));

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
    sessionDomains: z.array(z.string().max(120)).max(20),
    capturePatterns: z.array(z.string().max(300)).max(30),
    hidden: z.boolean(),
  })
  .partial();
api.post("/connections", async (req, res) => {
  const parsed = connectionPatch.safeParse(req.body);
  if (!parsed.success || !parsed.data.name) return bad(res, "name is required");
  const id = (typeof req.body?.id === "string" && req.body.id ? req.body.id : parsed.data.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!id || getPlatform(id)?.appUrl) return bad(res, "an AI with that name already exists");
  const appUrl = parsed.data.appUrl || "";
  if (appUrl && !/^https?:\/\//.test(appUrl)) return bad(res, "URL must start with http:// or https://");
  await savePlatformOverride(id, { ...parsed.data, hidden: false, chatUrl: parsed.data.chatUrl || appUrl, composerSelector: parsed.data.composerSelector || (appUrl ? "textarea, div[contenteditable=\"true\"]" : ""), replySelector: parsed.data.replySelector || "" });
  res.json(await connectionCard(getPlatform(id)!));
});
api.put("/connections/:id", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown AI", 404);
  const parsed = connectionPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid settings", issues: parsed.error.issues });
  await savePlatformOverride(p.id, parsed.data);
  res.json(await connectionCard(getPlatform(p.id)!));
});
api.delete("/connections/:id", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown AI", 404);
  // A built-in provider is hidden (its defaults come back if re-added); a hand-added one is really removed.
  if (getProvider(p.id)?.builtin) await savePlatformOverride(p.id, { hidden: true });
  else await deletePlatformOverride(p.id);
  res.json({ ok: true });
});
api.post("/connections/:id/restore", async (req, res) => {
  await deletePlatformOverride(req.params.id);
  const p = getPlatform(req.params.id);
  res.json(p ? await connectionCard(p) : { ok: true });
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
const signInOptions = async (a: ReturnType<typeof requireProvider>) => {
  const d = await desktopState();
  return { preferred: await a.preferredSignIn(), desktop: d.canDesktop, local: { ok: d.enabled }, vnc: { available: await vncAvailable(), url: VNC_PATH } };
};

/* local: the user signs in on their own computer and a helper hands the session to the cloud browser. */
api.post("/connections/:id/pairing", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    if (!a.supports("signIn")) throw a.unsupported("signIn");
    const desk = await desktopState();
    if (!desk.enabled) return bad(res, "the browser is disabled on this deployment, so there is nowhere to put a sign-in", 409);
    if (desk.signIn) return bad(res, `a sign-in to ${desk.signIn.platform} is open on the cloud desktop; finish or cancel it first`, 409);
    const { row, code } = await createPairing(a.id);
    const base = (config.publicUrl || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "");
    const secure = /^https:/i.test(base) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(base);
    // The helper is one plain Node file this deployment serves, so a computer with no copy of the
    // project can fetch it and run it. Nothing in it is secret; it does nothing without a live code.
    const helperUrl = `${base}/connect.mjs`;
    const connect = {
      helperUrl,
      // Two lines, and curl.exe rather than curl: Command Prompt has no "irm", Windows PowerShell has
      // no "&&", and plain "curl" in PowerShell is an alias for Invoke-WebRequest, which rejects these
      // flags. This pair is the one form that works in both shells as it stands.
      windows: `curl.exe -fsSL ${helperUrl} -o acp-connect.mjs\nnode acp-connect.mjs ${base} ${code}`,
      unix: `curl -fsSL ${helperUrl} -o acp-connect.mjs && node acp-connect.mjs ${base} ${code}`,
      repo: `npm run connect -- ${base} ${code}`,
    };
    res.json({ ok: true, id: row.id, platform: a.id, name: a.name, code, expiresAt: row.expires_at, publicUrl: base, publicUrlSource: config.publicUrl ? config.publicUrlSource : "request", secure, connect, pairing: await activePairing(a.id) });
  } catch (err) {
    next(err);
  }
});
api.get("/connections/:id/pairing", async (req, res) => res.json(await activePairing(req.params.id)));
api.delete("/connections/:id/pairing", async (req, res) => {
  const ok = await cancelPairing(req.params.id);
  res.json({ ok, pairing: await activePairing(req.params.id) });
});

/** Bring the AI's sign-in page up in its tab; the live view then shows that tab for the user to sign in. */
api.post("/connections/:id/connect", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    if (!browserRuntimeAvailable()) return bad(res, "the browser is disabled on this deployment", 409);
    const found = await callBrowserOp<Awaited<ReturnType<typeof a.connect>>>("auth.connect", { platformId: a.id }, 120_000);
    if (found.blocked) await addAudit({ actor: "system", action: "signin.blocked", target: a.id, detail: found.challenge });
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
    const signIn = await callBrowserOp("desktop.start", { platformId: a.id }, 120_000);
    await addAudit({ actor: "you", action: "signin.desktop_started", target: a.id });
    res.json({ ok: true, platform: a.id, mode: "desktop", signIn, ...(await signInOptions(a)) });
  } catch (err) {
    next(err);
  }
});
/** The user pressed "I'm signed in": close the plain window, hand the profile back, and check. */
api.post("/connections/:id/signin/finish", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    const { wasDesktop, status } = await callBrowserOp<{ wasDesktop: boolean; status: string }>("desktop.finish", { platformId: a.id }, 120_000);
    if (status === "logged_in") {
      if (wasDesktop) await setSetting(`signin_mode:${a.id}`, "desktop");
      await addAudit({ actor: "you", action: "signin.completed", target: a.id, detail: wasDesktop ? "desktop" : "live" });
    }
    res.json({ ...await connectionCard(a.config()), status, mode: wasDesktop ? "desktop" : "live" });
  } catch (err) {
    next(err);
  }
});
api.post("/connections/:id/signin/cancel", async (req, res, next) => {
  try {
    requireProvider(req.params.id);
    res.json(await callBrowserOp("desktop.cancel", {}, 60_000));
  } catch (err) {
    next(err);
  }
});
/** After signing in: confirm the session and capture a screenshot. */
api.post("/connections/:id/check", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    const status = await callBrowserOp<string>("auth.check", { platformId: a.id }, 120_000);
    res.json({ ...(await connectionCard(a.config())), status });
  } catch (err) {
    next(err);
  }
});

/* conversations (threads in the chat panel) */
api.get("/conversations", async (_req, res) => res.json(await listConversations()));
api.post("/conversations", async (req, res) => res.json(await createConversation(typeof req.body?.title === "string" ? req.body.title : "")));
api.get("/conversations/:id", async (req, res) => {
  const c = await getConversation(num(req.params.id, 0));
  if (!c) return bad(res, "not found", 404);
  res.json({ conversation: c, messages: await Promise.all((await conversationMessages(c.id)).map(expandMessage)) });
});
api.patch("/conversations/:id", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
  const c = await updateConversation(num(req.params.id, 0), { title });
  if (!c) return bad(res, "not found", 404);
  res.json(c);
});
api.delete("/conversations/:id", async (req, res) => res.json({ ok: await deleteConversation(num(req.params.id, 0)) }));

/* chat */
const titleFrom = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 56 ? line.slice(0, 55).replace(/\s+\S*$/, "") + "…" : line;
};
api.get("/chat", async (req, res) => {
  const cid = num(req.query.conversation_id, 0);
  if (cid) return res.json(await Promise.all((await conversationMessages(cid, num(req.query.limit, 300))).map(expandMessage)));
  res.json((await Promise.all((await listMessages({ limit: num(req.query.limit, 40) })).map(expandMessage))).reverse());
});
api.post("/chat", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return bad(res, "Type something first.");
  if (text.length > 20_000) return bad(res, "That message is too long.");
  const chosen = typeof req.body?.platform === "string" && req.body.platform ? req.body.platform : null;
  if (chosen && !getPlatform(chosen)) return bad(res, "unknown AI", 404);
  let conversation = req.body?.conversation_id ? await getConversation(num(req.body.conversation_id, 0)) : undefined;
  if (!conversation) conversation = await createConversation(titleFrom(text));
  else if (!conversation.title) conversation = (await updateConversation(conversation.id, { title: titleFrom(text) }))!;
  const msg = await createMessage(text, conversation.id);
  // Questions about the control plane and commands about tasks are answered here; they never reach a provider.
  if (!chosen) {
    const intent = await classifyIntent(text);
    if (intent.kind !== "chat") {
      await handleControl(intent, msg.id);
      return res.json({ message: await expandMessage((await getMessage(msg.id))!), routed: "control", intent, conversation: await getConversation(conversation.id) });
    }
  }
  if (chosen) {
    await updateMessage(msg.id, { routing: { method: "manual", confidence: 1, reason: "You chose it." } });
    // Respond right away; the reply lands in the thread when the AI answers.
    res.json({ message: await expandMessage((await getMessage(msg.id))!), routed: chosen, conversation: await getConversation(conversation.id) });
    void queue.send<ChatDeliverJob>(JOB.chatDeliver, { messageId: msg.id, platformId: chosen });
    return;
  }
  const routing = await routeToConnection(text);
  await updateMessage(msg.id, {
        suggestions: routing.options,
        routing: { method: routing.method, confidence: routing.top?.confidence ?? 0, reason: routing.reason, llm_error: routing.llm_error },
      });
  if (routing.top && routing.top.confidence >= config.router.autoThreshold) {
    res.json({ message: await expandMessage((await getMessage(msg.id))!), routed: routing.top.platform, conversation: await getConversation(conversation.id) });
    void queue.send<ChatDeliverJob>(JOB.chatDeliver, { messageId: msg.id, platformId: routing.top.platform });
    return;
  }
  res.json({ message: await expandMessage((await getMessage(msg.id))!), routed: null, conversation: await getConversation(conversation.id) });
});
api.post("/chat/:id/send", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const platform = String(req.body?.platform ?? "");
  const p = getPlatform(platform);
  if (!p) return bad(res, "unknown AI", 404);
  await updateMessage(m.id, { routing: { method: "manual", confidence: 1, reason: "You chose it." } });
  res.json({ ok: true });
  void queue.send<ChatDeliverJob>(JOB.chatDeliver, { messageId: m.id, platformId: platform });
});
/** Manual mode: the agent paused before an action and waits for this. */
api.post("/chat/:id/approve", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const decision = req.body?.decision === "reject" || req.body?.decision === "rejected" ? "rejected" : "approved";
  const row = await decideForMessage(m.id, decision);
  if (!row) return bad(res, "nothing is waiting for approval on this message", 409);
  res.json({ ok: true, decision, approval: row });
});
/** Stop a task that is running. If the message was already sent, only the wait is stopped. */
api.post("/chat/:id/cancel", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  if (!["assigned", "delivered"].includes(m.status)) return bad(res, "nothing is running for this message", 409);
  const run = await runForMessage(m.id);
  if (run) await requestCancel(run.id);
  await decideForMessage(m.id, "rejected");
  res.json({ ok: true, run_id: run?.id ?? null });
});
api.delete("/chat/:id", async (req, res) => res.json({ ok: await deleteMessage(num(req.params.id, 0)) }));

/* execution mode: auto (the agent acts on its own) or manual (it asks before acting) — a preset over the policies */
const approvalView = (a: Awaited<ReturnType<typeof pendingApprovals>>[number]) => ({ ...a, messageId: a.message_id, runId: a.run_id });
api.get("/settings/approval", async (_req, res) => res.json({ approvalMode: await approvalMode(), pending: (await pendingApprovals()).map(approvalView) }));
api.put("/settings/approval", async (req, res) => {
  const mode = req.body?.approvalMode === "manual" ? "manual" : req.body?.approvalMode === "auto" ? "auto" : null;
  if (!mode) return bad(res, "approvalMode must be auto or manual");
  await setApprovalMode(mode);
  res.json({ approvalMode: mode });
});

/* approvals: everything waiting for you, and what was decided */
api.get("/approvals", async (req, res) => {
  res.json({ pending: (await pendingApprovals()).map(approvalView), recent: (await listApprovals({ status: ["approved", "rejected", "expired", "interrupted"], limit: num(req.query.limit, 30) })).map(approvalView) });
});
api.post("/approvals/:id/decide", async (req, res) => {
  const decision = req.body?.decision === "reject" || req.body?.decision === "rejected" ? "rejected" : req.body?.decision === "approve" || req.body?.decision === "approved" ? "approved" : null;
  if (!decision) return bad(res, "decision must be approve or reject");
  const row = await decide(num(req.params.id, 0), decision, "you", typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null);
  if (!row) return bad(res, "that approval is not pending", 409);
  res.json({ ok: true, approval: approvalView(row) });
});

/* policies: which actions go ahead and which ask */
api.get("/policies", async (_req, res) => res.json(await listPolicies()));
api.put("/policies/:action", async (req, res, next) => {
  try {
    const mode = req.body?.mode;
    if (mode !== null && mode !== "auto" && mode !== "ask" && mode !== "always") return bad(res, "mode must be auto, ask, always or null");
    res.json(await setPolicy(req.params.action.slice(0, 60), mode));
  } catch (err) {
    next(err);
  }
});

/* one call for the whole app */
api.get("/home", async (req, res) => {
  const connections = await Promise.all(visiblePlatforms().map((p) => connectionCard(p)));
  const conversations = await listConversations();
  const wanted = num(req.query.conversation_id, 0);
  const current = (wanted ? await getConversation(wanted) : undefined) ?? conversations[0] ?? null;
  const runs = (await listRuns({ limit: 15 })).map((r) => ({ kind: "run", at: r.finished_at || r.started_at || r.created_at, platform: r.provider, title: r.label ?? r.task_name ?? r.kind, status: r.status, summary: r.summary, link: r.output_url || r.task_native_url, run_id: r.id, run_kind: r.kind }));
  const events = (await listEvents({ limit: 15 })).map((e) => ({ kind: e.kind, at: e.occurred_at, platform: e.platform, title: e.title, status: e.kind === "run" ? "failed" : e.kind === "session" ? "needs_attention" : "info", summary: e.body, link: e.link, id: e.id, read: !!e.read }));
  const activity = [...runs, ...events].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
  const attention = [
    ...connections.filter((c) => c.status === "needs_login").map((c) => ({ kind: "session", platform: c.id, title: `${c.name} needs you to sign in again`, action: "connect" })),
    ...(await listMessages({ status: "needs_assignment", limit: 10 })).map((m) => ({ kind: "message", id: m.id, title: "Which AI should do this?", body: m.text, action: "choose" })),
    ...(await listMessages({ status: "failed", limit: 10 })).map((m) => ({ kind: "message", id: m.id, title: "Could not send an instruction", body: m.error ?? m.text, action: "retry" })),
    ...(await listEvents({ unread: true, limit: 10 })).filter((e) => e.kind === "run").map((e) => ({ kind: "run", id: e.id, platform: e.platform, title: e.title, body: e.body, link: e.link, action: "dismiss" })),
  ];
  res.json({
    connections,
    conversations,
    conversation: current,
    messages: current ? await Promise.all((await conversationMessages(current.id)).map(expandMessage)) : [],
    approvalMode: await approvalMode(),
    approvals: (await pendingApprovals()).map(approvalView),
    agents: await listAgentProfiles(),
    overview: await overview(),
    // So a reloaded page can pick up a desktop sign-in that is still in progress.
    signInOptions: { desktop: browser.canDesktopSignIn(), vnc: { available: await vncAvailable(), url: VNC_PATH } },
    attention,
    activity,
    router: { llm: config.router.llm, provider: config.router.provider, model: config.router.model, autoThreshold: config.router.autoThreshold },
    storage: await storageInfo(),
    browser: await browser.status(),
    scheduler: schedulerStatus(),
    alerts: { configured: alertsConfigured() },
    email: emailStatus(),
    publicUrl: config.publicUrl,
    connectedCount: (await connectedPlatforms()).length,
    viewers: { stream: streamClients(), live: liveViewers() },
  });
});

/* settings */
api.get("/settings", async (_req, res) => {
  res.json({
    passwordFromEnv: adminFromEnv(),
    ingestToken: await ingestToken(),
    ingestTokenFromEnv: !!process.env.ACP_INGEST_TOKEN,
    router: { provider: config.router.provider, model: config.router.model, llm: config.router.llm },
    alerts: { webhook: !!config.alerts.webhookUrl, telegram: !!(config.alerts.telegramToken && config.alerts.telegramChatId) },
    email: emailStatus(),
    storage: await storageInfo(),
    syncIntervalMin: config.sync.intervalMin,
  });
});
api.post("/settings/password", async (req, res) => {
  const current = String(req.body?.current ?? "");
  const next = String(req.body?.next ?? "");
  if (next.length < 8) return bad(res, "Use at least 8 characters.");
  if (adminFromEnv() && (res.locals.user as AuthUser).id === 0) return bad(res, "The password is set by ACP_ADMIN_TOKEN on the server; change it there.", 409);
  if (!await changeAdminPassword(current, next, res.locals.user as AuthUser)) return bad(res, "Current password is wrong.", 401);
  // Every other browser of THIS account is signed out; this one continues on a fresh session.
  res.setHeader("Set-Cookie", sessionCookieHeader(secure(req), await createSession(req, res.locals.user as AuthUser)));
  res.json({ ok: true });
});
/* ---------- accounts (people who sign in here) ---------- */

api.get("/users", requireRole("owner", "admin"), async (_req, res) => res.json(await listUsers()));
api.post("/users", requireRole("owner", "admin"), async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 200) : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const role = req.body?.role === "admin" || req.body?.role === "member" ? req.body.role : "member";
  if (!email.includes("@")) return bad(res, "A real email address, please.");
  if (password.length < 8) return bad(res, "Use at least 8 characters.");
  if (await getUserByEmail(email)) return bad(res, "That email already has an account.", 409);
  const u = await createUser({ email, password_hash: await hashPassword(password), role });
  await addAudit({ actor: (res.locals.user as AuthUser).email, action: "user.created", target: email, detail: role });
  res.json({ ok: true, user: { id: u.id, email: u.email, role: u.role } });
});
api.put("/users/:id/role", requireRole("owner"), async (req, res) => {
  const role = req.body?.role;
  if (role !== "owner" && role !== "admin" && role !== "member") return bad(res, "role must be owner, admin or member");
  const u = await getUser(num(req.params.id, 0));
  if (!u) return bad(res, "not found", 404);
  await updateUser(u.id, { role });
  await addAudit({ actor: (res.locals.user as AuthUser).email, action: "user.role_changed", target: u.email, detail: role });
  res.json({ ok: true });
});
api.delete("/users/:id", requireRole("owner"), async (req, res) => {
  const u = await getUser(num(req.params.id, 0));
  if (!u) return bad(res, "not found", 404);
  const me = res.locals.user as AuthUser;
  if (u.id === me.id) return bad(res, "You cannot delete your own account.", 409);
  await deleteSessionsForUser(u.id);
  await deleteUser(u.id);
  await addAudit({ actor: me.email, action: "user.deleted", target: u.email });
  res.json({ ok: true });
});

/** Who did what: logins, approvals, policy changes, exports, live-view control. */
api.get("/audit", async (req, res) => res.json(await listAudit({ limit: num(req.query.limit, 100), action: typeof req.query.action === "string" ? req.query.action : undefined })));
/** The server log, from memory: the last lines at any level, for debugging from inside the product. */
api.get("/logs", (req, res) => {
  const level = typeof req.query.level === "string" && ["debug", "info", "warn", "error"].includes(req.query.level) ? (req.query.level as Level) : undefined;
  res.json({ level: logLevel(), scopes: logScopes(), lines: recentLogs({ limit: num(req.query.limit, 500), level, scope: typeof req.query.scope === "string" ? req.query.scope : undefined, after: req.query.after ? num(req.query.after, 0) : undefined }) });
});
api.put("/logs/level", async (req, res, next) => {
  try {
    const level = setLogLevel(String(req.body?.level ?? ""));
    await addAudit({ actor: "you", action: "log.level", detail: level });
    res.json({ level });
  } catch (err) {
    next(err);
  }
});
api.post("/settings/ingest-token/rotate", async (_req, res) => res.json({ ingestToken: await rotateIngestToken(), fromEnv: !!process.env.ACP_INGEST_TOKEN }));

/* ---------- messages (instructions from you, routed to agents) ---------- */

api.get("/messages", async (req, res) => {
  res.json(
    await Promise.all(
      (
        await listMessages({
          status: typeof req.query.status === "string" ? req.query.status : undefined,
          task_id: req.query.task_id ? num(req.query.task_id, 0) : undefined,
          limit: num(req.query.limit, 50),
        })
      ).map(expandMessage),
    ),
  );
});
api.get("/messages/:id", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  res.json(await expandMessage(m));
});
api.post("/messages", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return bad(res, "text is required");
  if (text.length > 20_000) return bad(res, "text too long");
  const auto = req.body?.auto !== false;
  const msg = await createMessage(text);

  if (req.body?.task_id || req.body?.agent_id) {
    const agent = await getTask(num(req.body.task_id ?? req.body.agent_id, 0));
    if (!agent) return bad(res, "unknown agent", 404);
    await updateMessage(msg.id, { routing: { method: "manual", confidence: 1, reason: "You chose the agent." } });
    return res.json({ message: await assignAndDeliver(msg.id, agent.id), auto_assigned: false, chosen: true });
  }

  const routing = await routeMessage(text);
  await updateMessage(msg.id, {
        suggestions: routing.suggestions,
        routing: { method: routing.method, confidence: routing.confidence, reason: routing.reason, new_agent: routing.new_agent, llm_error: routing.llm_error },
      });
  if (auto && routing.top && routing.confidence >= config.router.autoThreshold) {
    return res.json({ message: await assignAndDeliver(msg.id, routing.top.task_id), auto_assigned: true });
  }
  await addEvent({
        kind: "message",
        title: routing.top ? "Instruction needs your confirmation" : "Instruction has no matching agent",
        body: text.slice(0, 300),
        dedupe_key: `message_assign:${msg.id}`,
      });
  res.json({ message: await expandMessage((await getMessage(msg.id))!), auto_assigned: false });
});
api.post("/messages/:id/assign", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const agent = await getTask(num(req.body?.task_id ?? req.body?.agent_id, 0));
  if (!agent) return bad(res, "unknown task", 404);
  res.json(await assignAndDeliver(m.id, agent.id));
});
api.post("/messages/:id/retry", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  if (!m.task_id) return bad(res, "message has no agent; assign it first", 409);
  res.json(await assignAndDeliver(m.id, m.task_id));
});
api.post("/messages/:id/reroute", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const routing = await routeMessage(m.text);
  const updated = (await updateMessage(m.id, {
      status: "needs_assignment",
      task_id: null,
      delivery_mode: null,
      error: null,
      suggestions: routing.suggestions,
      routing: { method: routing.method, confidence: routing.confidence, reason: routing.reason, new_agent: routing.new_agent, llm_error: routing.llm_error },
    }))!;
  res.json(await expandMessage(updated));
});
api.post("/messages/:id/status", async (req, res) => {
  const m = await getMessage(num(req.params.id, 0));
  if (!m) return bad(res, "not found", 404);
  const status = String(req.body?.status ?? "");
  if (!["done", "failed", "acknowledged", "delivered"].includes(status)) return bad(res, "invalid status");
  const response = typeof req.body?.response === "string" ? req.body.response : undefined;
  const updated = (await updateMessage(m.id, { status: status as "done", acked_at: new Date().toISOString(), response }))!;
  if (updated.run_id && (status === "done" || status === "failed")) await endRun(updated.run_id, { status: status === "done" ? "success" : "failed", summary: response ?? null });
  res.json(await expandMessage(updated));
});
api.delete("/messages/:id", async (req, res) => res.json({ ok: await deleteMessage(num(req.params.id, 0)) }));

/* what is running, scheduled, finished, failed, and what needs you: real rows only */
api.get("/overview", async (_req, res) => res.json(await overview()));
/** The unified activity feed: every timeline line across every run, newest first. */
api.get("/activity", async (req, res) => {
  res.json(await activity({ limit: num(req.query.limit, 100), provider: typeof req.query.provider === "string" ? req.query.provider : undefined, agent_id: req.query.agent_id ? num(req.query.agent_id, 0) : undefined, run_id: req.query.run_id ? num(req.query.run_id, 0) : undefined }));
});
/** Provider diagnostics for developers: state, captured payloads, actions. */
api.get("/diagnostics", async (_req, res) => {
  const platforms = getPlatforms();
  const states = Object.fromEntries((await allPlatformStates()).map((s) => [s.platform, s]));
  const cards = Object.values(platforms).map(async (p) => {
    const s = states[p.id] ?? await getPlatformState(p.id);
    let meta: Record<string, unknown> = {};
    try {
      meta = s.meta ? JSON.parse(s.meta) : {};
    } catch {
      meta = {};
    }
    return { id: p.id, name: p.name, syncable: !!p.tasksUrl, state: { ...s, meta: { finalUrl: meta.finalUrl, title: meta.title, snapshotAt: meta.snapshotAt } }, hasScreenshot: !!(s.screenshot_path && fs.existsSync(s.screenshot_path)), tasks: (await listTasks({ platform: p.id })).length, actions: availableActions(p) };
  });
  res.json({ counts: { ...await overviewCounts(), openMessages: await openMessageCount() }, platforms: cards, router: { llm: config.router.llm, provider: config.router.provider, model: config.router.model, autoThreshold: config.router.autoThreshold }, storage: await storageInfo(), scheduler: schedulerStatus(), browser: await browser.status(), email: emailStatus(), alerts: { configured: alertsConfigured() }, publicUrl: config.publicUrl, publicUrlSource: config.publicUrlSource, schema: await schemaVersion() });
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

api.get("/tasks", async (req, res) => {
  res.json(await listTaskViews({ platform: typeof req.query.platform === "string" ? req.query.platform : undefined, agent_id: req.query.agent_id ? num(req.query.agent_id, 0) : undefined, includeDisabled: req.query.all === "1" }));
});
api.get("/tasks/:id", async (req, res) => {
  const t = (await listTasks({ includeDisabled: true })).find((x) => x.id === num(req.params.id, 0));
  if (!t) return bad(res, "not found", 404);
  res.json({ ...await taskView(t, await recentStatusesByTask(10)), runs: await listRuns({ task_id: t.id, limit: 20 }) });
});
api.post("/tasks", async (req, res) => {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid task", issues: parsed.error.issues });
  const d = parsed.data;
  const key = d.key || d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `task-${Date.now()}`;
  const task = await upsertTask({ ...d, key, platform: d.platform.toLowerCase(), source: "registry" });
  await ensureTaskAgent(task);
  res.json(await taskView({ ...(await getTask(task.id))!, last_run: null }));
});
const taskPatch = agentSchema.partial().extend({ prompt: z.string().max(20_000).nullable().optional(), configuration: z.record(z.string(), z.unknown()).nullable().optional() });
const patchTask = async (req: Request, res: Response) => {
  const parsed = taskPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid task", issues: parsed.error.issues });
  const t = await updateTask(num(req.params.id, 0), parsed.data);
  if (!t) return bad(res, "not found", 404);
  await addAudit({ actor: "you", action: parsed.data.enabled === false ? "task.paused" : parsed.data.enabled === true ? "task.resumed" : "task.updated", target: `task:${t.id}`, detail: t.name });
  res.json(await taskView({ ...t, last_run: (await listRuns({ task_id: t.id, limit: 1 }))[0] ?? null }));
};
api.put("/tasks/:id", patchTask);
api.patch("/tasks/:id", patchTask);
api.delete("/tasks/:id", async (req, res) => {
  res.json({ ok: await deleteTask(num(req.params.id, 0)) });
});
/** Start a task now, where the provider allows it. Goes through the run_task policy. */
api.post("/tasks/:id/run", async (req, res, next) => {
  try {
    await addAudit({ actor: "you", action: "task.run_requested", target: `task:${req.params.id}` });
    const run = await startTask(num(req.params.id, 0), { text: typeof req.body?.text === "string" ? req.body.text.slice(0, 20_000) : undefined, trigger: "user", idempotencyKey: req.header("idempotency-key")?.slice(0, 200) });
    res.json({ ok: run.status !== "failed", run: { ...run, events: await runEvents(run.id), steps: foldSteps(await runEvents(run.id)) } });
  } catch (err) {
    next(err);
  }
});

/* ---------- stats ---------- */

api.get("/stats/runs", async (req, res) => res.json(await runStats(num(req.query.days, 14))));

/* ---------- agent profiles (who does the work) ---------- */

api.get("/agents", async (req, res) => {
  res.json(await listAgentProfiles({ provider: typeof req.query.provider === "string" ? req.query.provider : undefined, kind: typeof req.query.kind === "string" ? req.query.kind : undefined, includeDisabled: req.query.all === "1" }));
});
api.get("/agents/:id", async (req, res) => {
  const a = await getAgentProfile(num(req.params.id, 0));
  if (!a) return bad(res, "not found", 404);
  res.json({ ...a, tasks: await listTasks({ agent_id: a.id }), runs: await listRuns({ agent_id: a.id, limit: 20 }) });
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
api.post("/agents", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const d = parsed.data;
  res.json(await upsertAgentProfile({ key: d.key, name: d.name, description: d.description ?? null, capabilities: d.capabilities ?? null, provider_id: (d.provider ?? "custom").toLowerCase(), kind: "custom", configuration: d.configuration }));
});
api.patch("/agents/:id", async (req, res) => {
  const parsed = profilePatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid agent", issues: parsed.error.issues });
  const a = await updateAgentProfile(num(req.params.id, 0), parsed.data);
  if (!a) return bad(res, "not found", 404);
  res.json(a);
});
api.delete("/agents/:id", async (req, res) => {
  const a = await getAgentProfile(num(req.params.id, 0));
  if (!a) return bad(res, "not found", 404);
  if (a.kind !== "custom") return bad(res, "only your own agents can be removed; assistants belong to their provider", 409);
  res.json({ ok: await deleteAgentProfile(a.id) });
});

/* ---------- runs & events ---------- */

api.get("/runs", async (req, res) => {
  res.json(
    await listRuns({
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
api.get("/runs/:id", async (req, res) => {
  const run = await getRun(num(req.params.id, 0));
  if (!run) return bad(res, "not found", 404);
  const events = await runEvents(run.id);
  res.json({ ...run, events, steps: foldSteps(events) });
});
api.get("/events", async (req, res) => {
  res.json(await listEvents({ limit: num(req.query.limit, 50), unread: req.query.unread === "1", platform: typeof req.query.platform === "string" ? req.query.platform : undefined }));
});
api.post("/events/:id/read", async (req, res) => res.json({ ok: await markEventRead(num(req.params.id, 0), req.body?.read !== false) }));
api.post("/events/read-all", async (_req, res) => res.json({ ok: true, changed: await markAllEventsRead() }));

/* ---------- platforms ---------- */

api.get("/platforms", (_req, res) => {
  const platforms = getPlatforms();
  res.json(Object.values(platforms).map(async (p) => ({ ...p, state: await getPlatformState(p.id), actions: availableActions(p) })));
});
api.get("/platforms/:id", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown platform", 404);
  const s = await getPlatformState(p.id);
  let meta: unknown = null;
  try {
    meta = s.meta ? JSON.parse(s.meta) : null;
  } catch {
    meta = null;
  }
  res.json({ ...p, state: { ...s, meta }, actions: availableActions(p), captures: await listCaptures(p.id, 50) });
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
    sessionDomains: z.array(z.string().max(120)).max(20),
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
api.put("/platforms/:id", async (req, res) => {
  const id = req.params.id.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!id) return bad(res, "invalid id");
  const parsed = platformPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid platform config", issues: parsed.error.issues });
  res.json(await savePlatformOverride(id, parsed.data));
});
api.delete("/platforms/:id/overrides", async (req, res) => {
  await deletePlatformOverride(req.params.id);
  res.json({ ok: true });
});
api.get("/platforms/:id/screenshot.png", async (req, res) => {
  const s = await getPlatformState(req.params.id);
  if (!s.screenshot_path || !fs.existsSync(s.screenshot_path)) return bad(res, "no screenshot yet", 404);
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(s.screenshot_path);
});
api.get("/platforms/:id/captures", async (req, res) => res.json(await listCaptures(req.params.id, num(req.query.limit, 100))));
api.get("/captures/:id", async (req, res) => {
  const c = await getCapture(num(req.params.id, 0));
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
  if (!browserRuntimeAvailable()) return bad(res, "browser is disabled", 409);
  if (isSyncRunning()) return bad(res, "a sync is already running", 409);
  const ids = Array.isArray(req.body?.platforms) ? (req.body.platforms as string[]) : undefined;
  res.json({ ok: true, results: await callBrowserOp("sync.all", { platformIds: ids ?? null }, 15 * 60_000) });
});
api.post("/platforms/:id/sync", async (req, res, next) => {
  try {
    const a = requireProvider(req.params.id);
    if (!a.supports("listTasks")) throw a.unsupported("listTasks");
    if (!browserRuntimeAvailable()) return bad(res, "browser is disabled", 409);
    res.json(await callBrowserOp("sync.provider", { platformId: a.id }, 5 * 60_000));
  } catch (err) {
    next(err);
  }
});
api.post("/platforms/:id/actions/:action", async (req, res) => {
  const p = getPlatform(req.params.id);
  if (!p) return bad(res, "unknown platform", 404);
  const taskId = req.body?.task_id || req.body?.agent_id ? num(req.body.task_id ?? req.body.agent_id, 0) : null;
  res.json(await callBrowserOp("action.run", { platformId: p.id, action: req.params.action, taskId, vars: {} }, 5 * 60_000));
});
api.get("/sync/log", async (_req, res) => res.json(await recentSyncLogs(50)));

/* ---------- browser ---------- */

api.get("/browser", async (_req, res) => {
  const domains = Object.values(getPlatforms())
    .map((p) => p.cookieDomain)
    .filter(Boolean);
  res.json({ ...(await browser.status()), vnc: { connections: vncState.connections }, storage: await storageInfo(), cookies: await browser.cookieCounts(domains) });
});
api.post("/browser/backup", async (_req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  res.json({ ok: true, cookies: await browser.backupSessions(), storage: storageInfo() });
});
api.post("/browser/import-state", async (req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : [];
  if (!cookies.length) return bad(res, "body must be a Playwright storageState with a cookies array");
  await addAudit({ actor: "you", action: "browser.import_state", detail: `${cookies.length} cookies from ${clientIp(req)}` });
  res.json({ ok: true, imported: await browser.importState({ cookies }) });
});
api.get("/browser/export-state", async (req, res) => {
  if (!browser.enabled) return bad(res, "browser is disabled", 409);
  // Cookies for every signed-in provider leave the server here; that is always worth a record.
  await addAudit({ actor: "you", action: "browser.export_state", detail: clientIp(req) });
  res.json(await browser.exportState());
});
api.post("/browser/open", async (req, res) => {
  const platform = typeof req.body?.platform === "string" ? req.body.platform : "";
  const p = getPlatform(platform);
  if (!p) return bad(res, "unknown platform", 404);
  const url = typeof req.body?.url === "string" && /^https?:\/\//.test(req.body.url) ? req.body.url : p.tasksUrl || p.appUrl;
  if (!url) return bad(res, "no url");
  const r = await callBrowserOp<{ ok: boolean; message: string }>("console.open", { platformId: p.id, url }, 90_000);
  if (!r.ok) return bad(res, r.message, 409);
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
