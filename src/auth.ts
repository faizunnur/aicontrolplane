import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export const SESSION_COOKIE = "acp_session";

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1];
}

/** True when the request carries the admin token (header) or the dashboard session cookie. */
export function isAdmin(req: IncomingMessage): boolean {
  const b = bearer(req);
  if (b && safeEqual(b, config.adminToken)) return true;
  const c = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (c && safeEqual(c, tokenHash(config.adminToken))) return true;
  const q = (req as Request).query?.token;
  if (typeof q === "string" && safeEqual(q, config.adminToken)) return true;
  return false;
}

export function isIngest(req: IncomingMessage): boolean {
  const b = bearer(req);
  if (b && (safeEqual(b, config.ingestToken) || safeEqual(b, config.adminToken))) return true;
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && (safeEqual(key, config.ingestToken) || safeEqual(key, config.adminToken))) return true;
  return false;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

export function requireIngest(req: Request, res: Response, next: NextFunction) {
  if (isIngest(req)) return next();
  res.status(401).json({ error: "unauthorized: send Authorization: Bearer <ACP_INGEST_TOKEN>" });
}

export function sessionCookieHeader(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${tokenHash(config.adminToken)}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
