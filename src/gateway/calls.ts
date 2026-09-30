import { randomUUID } from "node:crypto";
import type { JobFrame } from "../../packages/core/src/gateway.js";
import { getPlatform } from "../platforms.js";
import { connectorFor, type Connector } from "./registry.js";

/*
  Jobs in flight on desktop connectors: a browser op sent as a job frame, answered by a
  result frame with the same id. Kept apart from the socket code (server.ts) so the delivery
  and browser-op paths can send a job without importing the browser layer the socket feeds.
*/

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

interface Pending {
  conn: Connector;
  resolve(value: unknown): void;
  reject(err: unknown): void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, Pending>();

/** Run one browser op on the workspace's connected computer. Rejects with a GatewayError (503 not connected, 504 no answer, 502 it failed there). */
export function gatewayCall<T>(org: number, op: string, payload: unknown, timeoutMs = 90_000): Promise<T> {
  const conn = connectorFor(org);
  if (!conn) return Promise.reject(new GatewayError("your computer is not connected", 503));
  const jobId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(jobId);
      reject(new GatewayError(`your computer did not answer within ${Math.round(timeoutMs / 1000)}s`, 504));
    }, timeoutMs);
    timer.unref?.();
    pending.set(jobId, { conn, resolve: resolve as (v: unknown) => void, reject, timer });
    // The provider's configuration travels with the job (read in the caller's workspace scope),
    // so the connector drives what the workspace has configured right now, not a stale copy.
    const pid = payload && typeof payload === "object" ? (payload as { platformId?: unknown }).platformId : undefined;
    const platform = typeof pid === "string" ? getPlatform(pid) : undefined;
    const job: JobFrame = { t: "job", jobId, op, payload, timeoutMs, ...(platform ? { platform } : {}) };
    conn.send(job);
  });
}

/** A result frame arrived. Only the device the job went to may answer it. */
export function settleJob(conn: Connector, jobId: string, ok: boolean, value: unknown, error?: string): void {
  const p = pending.get(String(jobId));
  if (!p || p.conn.deviceId !== conn.deviceId) return;
  clearTimeout(p.timer);
  pending.delete(String(jobId));
  if (ok) p.resolve(value);
  else p.reject(new GatewayError(String(error ?? "the job failed on your computer").slice(0, 500), 502));
}

/** The connector went away: everything waiting on it fails now rather than at its timeout. */
export function rejectJobsFor(conn: Connector, why: string): void {
  for (const [id, p] of pending) {
    if (p.conn !== conn) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new GatewayError(why, 503));
  }
}

/** How many jobs are waiting on connectors right now (diagnostics). */
export function pendingGatewayJobs(): number {
  return pending.size;
}
