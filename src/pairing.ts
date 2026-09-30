import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { authUser, bearer, tokenHash } from "./auth.js";
import { addAudit, announceEvent, expirePairings, findPairingByCodeHash, findPairingByTokenHash, getPairing, insertPairing, latestPairing, replaceWaitingPairings, updatePairing, withOrg, type PairingRow, type PairingStatus } from "./db.js";
import { logger } from "./logger.js";

/*
  Signing in from your own computer. Some sign-in pages refuse any browser running in a datacenter,
  automated or not. For those the sign-in happens on the user's machine and only the resulting
  session travels to the cloud browser:

    app: create a pairing      → an 8-character code, single use, 10 minutes
    helper: exchange the code  → a token that can do one thing: hand ONE provider's session to
                                 POST /api/connections/:id/import-session, for 20 minutes, once
    helper: import the session → the pairing ends (done or failed) and the token is gone

  Codes and tokens are stored hashed. Every step is audited. The token satisfies nothing else:
  isAdmin() and isIngest() only know the password, the session cookie and the ingest token.
*/

const log = logger("pairing");

export const CODE_TTL_MS = 10 * 60_000;
export const TOKEN_TTL_MS = 20 * 60_000;
/** Unambiguous characters only: no 0/O, 1/I. 32^8 possibilities, single use, ten minutes. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_PREFIX = "acp_pair_";
/** How long a finished pairing stays visible so a reloaded panel still sees the outcome. */
const OUTCOME_VISIBLE_MS = 2 * 60_000;

export function normaliseCode(s: string): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
const formatCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** What the UI and the stream see: never the hashes. */
export interface PairingView {
  id: number;
  platform: string;
  status: PairingStatus;
  detail: string | null;
  expires_at: string;
  paired_at: string | null;
  finished_at: string | null;
}
function view(row: PairingRow): PairingView {
  return { id: row.id, platform: row.platform, status: row.status, detail: row.detail, expires_at: row.expires_at, paired_at: row.paired_at, finished_at: row.finished_at };
}
function announce(row: PairingRow) {
  // Through the outbox, in the pairing's own workspace: the helper's exchange runs on an
  // unauthenticated route, so the ambient scope cannot name the org. The outbox gives the
  // events a replay id — a page that reconnects around the flip still hears it.
  withOrg(row.org_id, () => {
    announceEvent("pairing", view(row));
    announceEvent("platform:row", row.platform);
  });
}

export async function createPairing(platform: string): Promise<{ row: PairingRow; code: string }> {
  await expirePairings();
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const row = await insertPairing({ platform, code_hash: tokenHash(code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  const replaced = await replaceWaitingPairings(platform, row.id);
  await addAudit({ actor: "you", action: "signin.pairing_created", target: platform, detail: replaced ? `pairing #${row.id}; replaces ${replaced} earlier code(s)` : `pairing #${row.id}` });
  log.info(`pairing #${row.id} created for ${platform}; the code is good for ${CODE_TTL_MS / 60_000} minutes`);
  announce(row);
  return { row, code: formatCode(code) };
}

/** The helper trades the code for a token. Anything but a live, unused code answers null. */
export async function exchangePairing(code: string, ip: string): Promise<{ token: string; row: PairingRow } | null> {
  await expirePairings();
  const c = normaliseCode(code);
  if (c.length !== 8) return null;
  const row = await findPairingByCodeHash(tokenHash(c));
  if (!row) return null;
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const updated = (await updatePairing(row.id, { status: "paired", token_hash: tokenHash(token), expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(), paired_at: new Date().toISOString(), ip }))!;
  await addAudit({ actor: ip, action: "signin.pairing_exchanged", target: row.platform, detail: `pairing #${row.id}` });
  log.info(`pairing #${row.id} for ${row.platform}: a computer at ${ip} paired; waiting for the sign-in`);
  announce(updated);
  return { token, row: updated };
}

/** The pairing behind a request's bearer token, if it is a live pairing token. */
export async function pairingFromRequest(req: IncomingMessage): Promise<PairingRow | undefined> {
  const b = bearer(req);
  if (!b || !b.startsWith(TOKEN_PREFIX)) return undefined;
  await expirePairings();
  return await findPairingByTokenHash(tokenHash(b));
}

export async function markImporting(id: number) {
  const row = await updatePairing(id, { status: "importing" });
  if (row) announce(row);
}

/** Any completed attempt ends the pairing; its token is gone whatever the outcome. */
export async function finishPairing(id: number, status: "done" | "failed", detail: string | null = null): Promise<PairingRow | undefined> {
  const row = await updatePairing(id, { status, detail, token_hash: null, finished_at: new Date().toISOString() });
  if (!row) return undefined;
  if (status === "failed") await addAudit({ actor: "system", action: "signin.pairing_failed", target: row.platform, detail: detail ?? `pairing #${id}` });
  log.info(`pairing #${id} for ${row.platform} ${status}${detail ? `: ${detail}` : ""}`);
  announce(row);
  return row;
}

export async function cancelPairing(platform: string): Promise<boolean> {
  await expirePairings();
  const latest = await latestPairing(platform);
  if (!latest || !["waiting", "paired", "importing"].includes(latest.status)) return false;
  const row = (await updatePairing(latest.id, { status: "cancelled", token_hash: null, finished_at: new Date().toISOString() }))!;
  await addAudit({ actor: "you", action: "signin.pairing_cancelled", target: platform, detail: `pairing #${row.id}` });
  announce(row);
  return true;
}

/** The pairing a provider's card should show: one in progress, or one that just finished. */
export async function activePairing(platform: string): Promise<PairingView | null> {
  await expirePairings();
  const latest = await latestPairing(platform);
  if (!latest) return null;
  if (["waiting", "paired", "importing"].includes(latest.status)) return view(latest);
  if ((latest.status === "done" || latest.status === "failed") && latest.finished_at && Date.now() - new Date(latest.finished_at).getTime() < OUTCOME_VISIBLE_MS) return view(latest);
  return null;
}

export async function pairingById(id: number): Promise<PairingView | null> {
  const row = await getPairing(id);
  return row ? view(row) : null;
}

/**
 * The import route: a pairing token made for this very provider, or a signed-in owner/admin
 * importing into THEIR OWN workspace. A session is not enough by itself — the route must
 * know exactly whose cookie jar the import lands in, so the caller's resolved user (with
 * their orgId) rides along in res.locals.user; the route never falls back to a default org.
 */
export async function requirePairingFor(req: Request, res: Response, next: NextFunction) {
  const user = await authUser(req);
  if (user) {
    // A member must not hand sessions to the workspace browser; that is the operators' call.
    if (user.role !== "owner" && user.role !== "admin") return res.status(403).json({ error: "importing a session needs an owner or admin account" });
    res.locals.user = user;
    return next();
  }
  const row = await pairingFromRequest(req);
  if (!row) return res.status(401).json({ error: "unauthorized: this needs a live pairing token from the app (make a new code there)" });
  if (row.platform !== req.params.id) return res.status(403).json({ error: `that code was made for ${row.platform}, not ${req.params.id}` });
  res.locals.pairing = row;
  next();
}
