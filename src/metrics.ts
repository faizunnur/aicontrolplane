import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { rawAll } from "./db.js";
import { logger } from "./logger.js";

const log = logger("metrics");

/*
  Prometheus metrics: the numbers an operator scales and alerts on. Served at /metrics —
  admin-gated on the api (it faces the internet), open on the workers' internal health port.
  Queue depth and run states are sampled from the database at scrape time; request and job
  outcomes are counted as they happen.
*/

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "acp_" });

export const httpDuration = new Histogram({
  name: "acp_http_request_duration_seconds",
  help: "API request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const runsSettled = new Counter({
  name: "acp_runs_settled_total",
  help: "Runs that reached a terminal state, by status",
  labelNames: ["status", "kind"],
  registers: [registry],
});

export const jobsFailed = new Counter({
  name: "acp_jobs_failed_total",
  help: "Queue jobs whose handler threw",
  labelNames: ["job"],
  registers: [registry],
});

export const sseClients = new Gauge({ name: "acp_sse_clients", help: "Open event-stream connections", registers: [registry] });
export const liveViewers = new Gauge({ name: "acp_live_viewers", help: "Open live-view sockets", registers: [registry] });
export const browserContextsOpen = new Gauge({ name: "acp_browser_contexts_open", help: "Open fleet browser contexts (one per active workspace-provider connection)", registers: [registry] });
export const browserContextWaiters = new Gauge({ name: "acp_browser_context_waiters", help: "Jobs waiting for a fleet browser context slot", registers: [registry] });

new Gauge({
  name: "acp_queue_jobs",
  help: "Queued (not yet started) jobs per queue, sampled at scrape",
  labelNames: ["queue"],
  registers: [registry],
  async collect() {
    if (config.db.driver !== "pg") return;
    try {
      const rows = await rawAll<{ name: string; n: number }>("SELECT name, COUNT(*) AS n FROM pgboss.job WHERE state = 'created' GROUP BY name");
      this.reset();
      for (const r of rows) this.set({ queue: r.name }, Number(r.n));
    } catch {
      /* pg-boss schema absent until the first boss start */
    }
  },
});

new Gauge({
  name: "acp_runs_active",
  help: "Runs in non-terminal states, sampled at scrape",
  labelNames: ["status"],
  registers: [registry],
  async collect() {
    try {
      const rows = await rawAll<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM runs WHERE status IN ('running','queued','scheduled','waiting','waiting_approval','retrying') GROUP BY status");
      this.reset();
      for (const r of rows) this.set({ status: r.status }, Number(r.n));
    } catch (err) {
      log.debug("run gauge sample failed", err);
    }
  },
});

/** Express middleware: one histogram observation per API request, labeled by route pattern. */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const route = (req.baseUrl ?? "") + (req.route?.path ?? req.path.replace(/\/\d+(?=\/|$)/g, "/:id"));
    httpDuration.observe({ method: req.method, route: route.slice(0, 80), status: String(res.statusCode) }, Number(process.hrtime.bigint() - t0) / 1e9);
  });
  next();
}

export async function metricsText(): Promise<string> {
  return registry.metrics();
}
