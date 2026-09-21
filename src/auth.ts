import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";

export const SESSION_COOKIE = "acp_session";

/*
  Credentials come from the environment when set (ACP_ADMIN_TOKEN / ACP_INGEST_TOKEN),
  otherwise from a password the user creates on first visit, stored hashed in the database.
  The ingest token is generated at that moment and shown under Settings › Developer.
*/

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const envAdmin = process.env.ACP_ADMIN_TOKEN || "";
const envIngest = process.env.ACP_INGEST_TOKEN || "";

/** Hash of the admin password, or null when none exists yet (first run). */
function adminHash(): string | null {
  if (envAdmin) return tokenHash(envAdmin);
  return getSetting("admin_password_hash") ?? null;
}
export function setupRequired(): boolean {
  return adminHash() === null;
}
export function adminFromEnv(): boolean {
  return !!envAdmin;
}
export function verifyAdmin(password: string): boolean {
  const h = adminHash();
  return h !== null && safeEqual(tokenHash(password), h);
}
/** First-run only: create the password and an ingest token. Returns false if one already exists. */
export function createAdminPassword(password: string): boolean {
  if (!setupRequired()) return false;
  setSetting("admin_password_hash", tokenHash(password));
  if (!envIngest && !getSetting("ingest_token")) setSetting("ingest_token", randomBytes(24).toString("hex"));
  return true;
}
export function changeAdminPassword(current: string, next: string): boolean {
  if (envAdmin) return false;
  if (!verifyAdmin(current)) return false;
  setSetting("admin_password_hash", tokenHash(next));
  return true;
}
export function ingestToken(): string {
  if (envIngest) return envIngest;
  let t = getSetting("ingest_token");
  if (!t) {
    t = randomBytes(24).toString("hex");
    setSetting("ingest_token", t);
  }
  return t;
}
export function rotateIngestToken(): string {
  if (envIngest) return envIngest;
  const t = randomBytes(24).toString("hex");
  setSetting("ingest_token", t);
  return t;
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

/** The session cookie carries a hash of (hash of password); it changes when the password does. */
function sessionValue(): string | null {
  const h = adminHash();
  return h ? tokenHash("session:" + h) : null;
}

export function isAdmin(req: IncomingMessage): boolean {
  const b = bearer(req);
  if (b && verifyAdmin(b)) return true;
  const sv = sessionValue();
  const c = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sv && c && safeEqual(c, sv)) return true;
  const q = (req as Request).query?.token;
  if (typeof q === "string" && verifyAdmin(q)) return true;
  return false;
}

export function isIngest(req: IncomingMessage): boolean {
  const b = bearer(req);
  if (b && (safeEqual(b, ingestToken()) || verifyAdmin(b))) return true;
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && (safeEqual(key, ingestToken()) || verifyAdmin(key))) return true;
  return false;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: "unauthorized", setup: setupRequired() });
}

export function requireIngest(req: Request, res: Response, next: NextFunction) {
  if (isIngest(req)) return next();
  res.status(401).json({ error: "unauthorized: send Authorization: Bearer <ingest token>" });
}

export function sessionCookieHeader(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${sessionValue() ?? ""}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Keep config in sync for modules that only need to know whether an env token exists.
void config;
