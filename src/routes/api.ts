import fs from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { availableActions, runAction } from "../actions.js";
import { alertsConfigured, sendAlert } from "../alerts.js";
import { browser, vncState } from "../browser/manager.js";
import { config } from "../config.js";
import {
  addEvent,
  allPlatformStates,
  deleteAgent,
  getAgent,
  getCapture,
  getPlatformState,
  listAgents,
  listCaptures,
  listEvents,
  listRuns,
  markAllEventsRead,
  markEventRead,
  overviewCounts,
  recentSyncLogs,
  recordRun,
  updateAgent,
  upsertAgent,
} from "../db.js";
import { emailStatus, pollOnce } from "../ingest/email.js";
import { deletePlatformOverride, getPlatform, getPlatforms, savePlatformOverride } from "../platforms.js";
import { requireAdmin, requireIngest, clearSessionCookieHeader, sessionCookieHeader } from "../auth.js";
import { isSyncRunning, schedulerStatus, syncAll } from "../sync.js";
import { syncPlatform } from "../collect/collector.js";

export const api = Router();

const RUN_STATUS = z.enum(["success", "failed", "running", "needs_attention", "unknown"]);

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

/* ---------- auth ---------- */

api.post("/session", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (token !== config.adminToken) return bad(res, "invalid token", 401);
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

/* ---------- everything below is admin ---------- */

api.use(requireAdmin);

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
    counts: overviewCounts(),
    platforms: cards,
    attention: {
      runs: listRuns({ limit: 20 }).filter((r) => r.status === "failed" || r.status === "needs_attention"),
      events: listEvents({ unread: true, limit: 20 }),
      sessions: cards.filter((c) => c.state.session_status === "needs_login").map((c) => ({ platform: c.id, name: c.name })),
    },
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
});

api.get("/agents", (req, res) => {
  res.json(listAgents({ platform: typeof req.query.platform === "string" ? req.query.platform : undefined, includeDisabled: req.query.all === "1" }));
});
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
    nativeUrlTemplate: z.string().max(2000),
    snapshotSelector: z.string().max(300),
    notes: z.string().max(2000),
    actions: z.record(
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

api.get("/browser", async (_req, res) => res.json({ ...(await browser.status()), vnc: { connections: vncState.connections } }));
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
  await browser.withLock(() => browser.consolePage(p.id, url));
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
