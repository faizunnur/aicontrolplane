import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { addAudit, deleteAllSessions, deleteSession, findSession, getSetting, insertSession, purgeExpiredSessions, setSetting, touchSession } from "./db.js";

export const SESSION_COOKIE = "acp_session";
/** A login lasts this long without use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/*
  Credentials come from the environment when set (ACP_ADMIN_TOKEN / ACP_INGEST_TOKEN),
  otherwise from a password the user creates on first visit, stored hashed in the database.
  A login creates a session: a random token, stored hashed, sent as an HttpOnly cookie, and
  revocable one by one (logout) or all at once (password change). The ingest token is generated
  on first run and shown under Settings › Developer.
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
async function adminHash(): Promise<string | null> {
  if (envAdmin) return tokenHash(envAdmin);
  return await getSetting("admin_password_hash") ?? null;
}
export async function setupRequired(): Promise<boolean> {
  return await adminHash() === null;
}
export function adminFromEnv(): boolean {
  return !!envAdmin;
}
export async function verifyAdmin(password: string): Promise<boolean> {
  const h = await adminHash();
  return h !== null && safeEqual(tokenHash(password), h);
}
/** First-run only: create the password and an ingest token. Returns false if one already exists. */
export async function createAdminPassword(password: string): Promise<boolean> {
  if (!await setupRequired()) return false;
  await setSetting("admin_password_hash", tokenHash(password));
  if (!envIngest && !await getSetting("ingest_token")) await setSetting("ingest_token", randomBytes(24).toString("hex"));
  return true;
}
/** Changing the password signs every browser out; the caller issues a fresh session for this one. */
export async function changeAdminPassword(current: string, next: string): Promise<boolean> {
  if (envAdmin) return false;
  if (!await verifyAdmin(current)) return false;
  await setSetting("admin_password_hash", tokenHash(next));
  await deleteAllSessions();
  await addAudit({ actor: "you", action: "auth.password_changed" });
  return true;
}
export async function ingestToken(): Promise<string> {
  if (envIngest) return envIngest;
  let t = await getSetting("ingest_token");
  if (!t) {
    t = randomBytes(24).toString("hex");
    await setSetting("ingest_token", t);
  }
  return t;
}
export async function rotateIngestToken(): Promise<string> {
  if (envIngest) return envIngest;
  const t = randomBytes(24).toString("hex");
  await setSetting("ingest_token", t);
  await addAudit({ actor: "you", action: "auth.ingest_token_rotated" });
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

/** The Authorization: Bearer value, if any. Never read from the query string. */
export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1];
}

/* ---------- sessions ---------- */

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

/** Start a session for this browser. Returns the raw token to put in the cookie; only its hash is stored. */
export async function createSession(req: IncomingMessage): Promise<string> {
  await purgeExpiredSessions();
  const token = randomBytes(32).toString("base64url");
  await insertSession({ token_hash: tokenHash(token), expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(), user_agent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null, ip: clientIp(req) });
  await addAudit({ actor: "you", action: "auth.login", detail: clientIp(req) });
  return token;
}

const touched = new Map<number, number>();
async function sessionFromCookie(req: IncomingMessage) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return undefined;
  const s = await findSession(tokenHash(raw));
  if (!s) return undefined;
  // Note activity at most once a minute per session; the row is not worth a write per request.
  const last = touched.get(s.id) ?? 0;
  if (Date.now() - last > 60_000) {
    touched.set(s.id, Date.now());
    await touchSession(s.id);
  }
  return s;
}

/** End this browser's session. */
export async function revokeSession(req: IncomingMessage): Promise<boolean> {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return false;
  const ok = await deleteSession(tokenHash(raw));
  if (ok) await addAudit({ actor: "you", action: "auth.logout" });
  return ok;
}

/**
 * Admin access: the password as a bearer token (for scripts), or a live session cookie (the UI).
 * Never a token in the URL: it would land in logs and browser history.
 */
export async function isAdmin(req: IncomingMessage): Promise<boolean> {
  const b = bearer(req);
  if (b && await verifyAdmin(b)) return true;
  return await sessionFromCookie(req) !== undefined;
}

export async function isIngest(req: IncomingMessage): Promise<boolean> {
  const b = bearer(req);
  if (b && (safeEqual(b, await ingestToken()) || await verifyAdmin(b))) return true;
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && (safeEqual(key, await ingestToken()) || await verifyAdmin(key))) return true;
  return false;
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (await isAdmin(req)) return next();
  res.status(401).json({ error: "unauthorized", setup: await setupRequired() });
}

export async function requireIngest(req: Request, res: Response, next: NextFunction) {
  if (await isIngest(req)) return next();
  res.status(401).json({ error: "unauthorized: send Authorization: Bearer <ingest token>" });
}

export function sessionCookieHeader(secure: boolean, token: string): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** True when a browser request's Origin (if any) does not belong to this deployment. */
export function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return false;
  const host = req.headers.host;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

// Keep config in sync for modules that only need to know whether an env token exists.
void config;
