import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { config } from "./config.js";
import { withLogContext } from "./context.js";
import {
  addAudit,
  countUsers,
  createUser,
  deleteAllSessions,
  deleteSession,
  findOrgIdByIngestToken,
  findSession,
  getSetting,
  getSettingCached,
  getUser,
  getUserByEmail,
  insertSession,
  listAllUsers,
  purgeExpiredSessions,
  setSetting,
  touchSession,
  updateUser,
  withOrg,
  type UserRole,
  type UserRow,
} from "./db.js";

export const SESSION_COOKIE = "acp_session";
/** A login lasts this long without use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/*
  Real accounts. Users live in the users table with argon2id password hashes; a login creates
  a session (random token, stored hashed, HttpOnly cookie) that knows whose it is. The first
  user (created at setup, or migrated from the old single admin password) is the owner.
  Compatibility, deliberately kept:
    - ACP_ADMIN_TOKEN still works as a bearer credential and as the login password (it acts
      as the owner), so existing deployments and scripts keep working.
    - a login without an email works while there is exactly one user — the current UI and
      every existing test logs in that way.
    - a migrated "sha256:" hash verifies and upgrades itself to argon2 on the next login.
  The ingest token is separate and unchanged: agents, not people.
*/

export interface AuthUser {
  id: number;
  email: string;
  role: UserRole;
  /** The workspace every query this user makes is scoped to. */
  orgId: number;
}

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

/** The stand-in owner for ACP_ADMIN_TOKEN logins on deployments with no user rows. Founding workspace. */
const ENV_OWNER: AuthUser = { id: 0, email: "admin@env", role: "owner", orgId: 1 };

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

/** Verify against an argon2 hash, or a migrated legacy "sha256:" one. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (stored.startsWith("sha256:")) return safeEqual(tokenHash(password), stored.slice("sha256:".length));
  try {
    return await argonVerify(stored, password);
  } catch {
    return false;
  }
}

export async function setupRequired(): Promise<boolean> {
  if (envAdmin) return false;
  return (await countUsers()) === 0;
}
export function adminFromEnv(): boolean {
  return !!envAdmin;
}

/**
 * First run: create the owner (and an ingest token). Returns false when users already exist.
 */
export async function createAdminPassword(password: string, email = "admin@local"): Promise<boolean> {
  if (!(await setupRequired())) return false;
  // First run: the owner of the founding workspace, trusted by construction (no email round-trip).
  await withOrg(1, async () => {
    await createUser({ email, password_hash: await hashPassword(password), role: "owner" });
    if (!envIngest && !(await getSetting("ingest_token"))) await setSetting("ingest_token", randomBytes(24).toString("hex"));
  });
  return true;
}

/**
 * Who these credentials belong to. Email narrows it; without one, the single existing user
 * (or the env owner) is meant. A legacy hash that verifies upgrades itself to argon2.
 */
export async function verifyUser(password: string, email?: string): Promise<AuthUser | null> {
  if (envAdmin && safeEqual(password, envAdmin) && (!email || email === ENV_OWNER.email)) return ENV_OWNER;
  let user: UserRow | undefined;
  if (email) user = await getUserByEmail(email);
  else {
    const all = await listAllUsers();
    if (all.length === 1) user = await getUser(all[0].id);
    else if (all.length > 1) return null; // several accounts: the email says which
  }
  if (!user) return null;
  if (!(await verifyPassword(user.password_hash, password))) return null;
  if (user.password_hash.startsWith("sha256:")) await updateUser(user.id, { password_hash: await hashPassword(password) });
  await updateUser(user.id, { last_login_at: new Date().toISOString() });
  return { id: user.id, email: user.email, role: user.role, orgId: user.org_id };
}

/**
 * Which account a bare password (bearer credential) belongs to — with ITS OWN role, never
 * more. Successful matches are cached briefly (by token hash) and failures are counted per
 * caller, because argon2id is deliberate work and this path guards every API route.
 */
const bearerHits = new Map<string, { at: number; user: AuthUser }>();
const bearerFails = new Map<string, { count: number; resetAt: number }>();

export async function matchUserByPassword(password: string, callerIp = "unknown"): Promise<AuthUser | null> {
  const key = tokenHash(password);
  const hit = bearerHits.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.user;
  const fails = bearerFails.get(callerIp);
  if (fails && fails.resetAt > Date.now() && fails.count > 20) return null; // guessing costs nothing further
  // O(all accounts on the install) argon2 checks — tolerable now, the reason per-workspace
  // API keys are the successor to password-as-bearer.
  for (const u of await listAllUsers()) {
    const row = await getUser(u.id);
    if (row && (await verifyPassword(row.password_hash, password))) {
      const user: AuthUser = { id: row.id, email: row.email, role: row.role, orgId: row.org_id };
      if (bearerHits.size > 1000) bearerHits.clear();
      bearerHits.set(key, { at: Date.now(), user });
      return user;
    }
  }
  const now = Date.now();
  const f = fails && fails.resetAt > now ? fails : { count: 0, resetAt: now + 60_000 };
  f.count++;
  bearerFails.set(callerIp, f);
  return null;
}

/** Kept for scripts and the ingest path: does this password belong to any account? */
export async function verifyAdmin(password: string): Promise<boolean> {
  if (envAdmin && safeEqual(password, envAdmin)) return true;
  return (await matchUserByPassword(password)) !== null;
}

/** Change the signed-in user's password; every session (all users') stays untouched except theirs. */
export async function changeAdminPassword(current: string, next: string, user?: AuthUser | null): Promise<boolean> {
  if (envAdmin && (!user || user.id === 0)) return false;
  const target = user && user.id !== 0 ? await getUser(user.id) : null;
  if (target) {
    if (!(await verifyPassword(target.password_hash, current))) return false;
    await updateUser(target.id, { password_hash: await hashPassword(next) });
    const { deleteSessionsForUser } = await import("./db.js");
    await deleteSessionsForUser(target.id);
    await addAudit({ actor: target.email, action: "auth.password_changed" });
    return true;
  }
  // No session user resolved (legacy callers): fall back to the single-user behaviour.
  const who = await verifyUser(current);
  if (!who || who.id === 0) return false;
  await updateUser(who.id, { password_hash: await hashPassword(next) });
  await deleteAllSessions();
  await addAudit({ actor: who.email, action: "auth.password_changed" });
  return true;
}

export async function ingestToken(): Promise<string> {
  if (envIngest) return envIngest;
  let t = await getSettingCached("ingest_token");
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

/** Start a session for this user. Returns the raw token to put in the cookie; only its hash is stored. */
export async function createSession(req: IncomingMessage, user?: AuthUser | null): Promise<string> {
  await purgeExpiredSessions();
  const token = randomBytes(32).toString("base64url");
  await insertSession({
    token_hash: tokenHash(token),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    user_agent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null,
    ip: clientIp(req),
    user_id: user && user.id !== 0 ? user.id : null,
    org_id: user?.orgId ?? 1,
  });
  await withOrg(user?.orgId ?? 1, () => addAudit({ actor: user?.email ?? "you", action: "auth.login", detail: clientIp(req) }));
  return token;
}

const touched = new Map<number, number>();
const userCache = new Map<number, { at: number; user: AuthUser | null }>();

async function userById(id: number | null): Promise<AuthUser | null> {
  if (id === null) {
    // A session from before accounts existed, or an env-owner login: the first owner.
    return ENV_OWNER;
  }
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 5_000) return hit.user;
  const row = await getUser(id);
  const user = row ? { id: row.id, email: row.email, role: row.role, orgId: row.org_id } : null;
  userCache.set(id, { at: Date.now(), user });
  return user;
}

async function sessionFromCookie(req: IncomingMessage): Promise<{ sessionId: number; user: AuthUser } | undefined> {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return undefined;
  const s = await findSession(tokenHash(raw));
  if (!s) return undefined;
  const user = await userById(s.user_id);
  if (!user) return undefined; // the account was deleted; the session dies with it
  // Note activity at most once a minute per session; the row is not worth a write per request.
  const last = touched.get(s.id) ?? 0;
  if (Date.now() - last > 60_000) {
    touched.set(s.id, Date.now());
    await touchSession(s.id);
  }
  return { sessionId: s.id, user };
}

/** End this browser's session. */
export async function revokeSession(req: IncomingMessage): Promise<boolean> {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return false;
  const ok = await deleteSession(tokenHash(raw));
  if (ok) await addAudit({ actor: "you", action: "auth.logout" });
  return ok;
}

/** Whoever this request is, or null: a live session, or their own password as a bearer token. */
export async function authUser(req: IncomingMessage): Promise<AuthUser | null> {
  const b = bearer(req);
  if (b) {
    if (envAdmin && safeEqual(b, envAdmin)) return ENV_OWNER;
    // A password identifies ITS account, with its own role — a member's password must never
    // act as the owner.
    const matched = await matchUserByPassword(b, clientIp(req));
    if (matched) return matched;
  }
  return (await sessionFromCookie(req))?.user ?? null;
}

/**
 * Admin access: the password as a bearer token (for scripts), or a live session cookie (the UI).
 * Never a token in the URL: it would land in logs and browser history.
 */
export async function isAdmin(req: IncomingMessage): Promise<boolean> {
  return (await authUser(req)) !== null;
}

/**
 * Which workspace an agent's credential belongs to: its workspace's ingest token, or (for
 * scripts) a user's password. Null when the credential matches nothing.
 */
export async function resolveIngestOrg(req: IncomingMessage): Promise<number | null> {
  const keyHeader = req.headers["x-api-key"];
  for (const cred of [bearer(req), typeof keyHeader === "string" ? keyHeader : undefined]) {
    if (!cred) continue;
    if (envIngest && safeEqual(cred, envIngest)) return 1;
    if (envAdmin && safeEqual(cred, envAdmin)) return 1;
    const org = await findOrgIdByIngestToken(cred);
    if (org !== undefined) return org;
    const user = await matchUserByPassword(cred, clientIp(req));
    if (user) return user.orgId;
  }
  return null;
}

export async function isIngest(req: IncomingMessage): Promise<boolean> {
  return (await resolveIngestOrg(req)) !== null;
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized", setup: await setupRequired() });
  res.locals.user = user;
  // Every log line and audit row this request causes says who did it — and every query it
  // makes is scoped to their workspace.
  withLogContext({ user: user.email, org: user.orgId }, () => withOrg(user.orgId, () => next()));
}

/** Route gate for role-sensitive endpoints (user management, token rotation, policies). */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (!roles.includes(user.role)) return res.status(403).json({ error: `this needs one of: ${roles.join(", ")}` });
    next();
  };
}

export async function requireIngest(req: Request, res: Response, next: NextFunction) {
  const org = await resolveIngestOrg(req);
  if (org === null) return res.status(401).json({ error: "unauthorized: send Authorization: Bearer <ingest token>" });
  // Everything the agent reports lands in the workspace its token belongs to.
  withLogContext({ org }, () => withOrg(org, () => next()));
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
