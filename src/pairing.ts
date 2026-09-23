import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { bearer, isAdmin, tokenHash } from "./auth.js";
import { bus } from "./bus.js";
import { addAudit, expirePairings, findPairingByCodeHash, findPairingByTokenHash, getPairing, insertPairing, latestPairing, replaceWaitingPairings, updatePairing, type PairingRow, type PairingStatus } from "./db.js";
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
  bus.emit("pairing", view(row));
  bus.emit("platform:row", row.platform);
}

export function createPairing(platform: string): { row: PairingRow; code: string } {
  expirePairings();
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const row = insertPairing({ platform, code_hash: tokenHash(code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  const replaced = replaceWaitingPairings(platform, row.id);
  addAudit({ actor: "you", action: "signin.pairing_created", target: platform, detail: replaced ? `pairing #${row.id}; replaces ${replaced} earlier code(s)` : `pairing #${row.id}` });
  log.info(`pairing #${row.id} created for ${platform}; the code is good for ${CODE_TTL_MS / 60_000} minutes`);
  announce(row);
  return { row, code: formatCode(code) };
}

/** The helper trades the code for a token. Anything but a live, unused code answers null. */
export function exchangePairing(code: string, ip: string): { token: string; row: PairingRow } | null {
  expirePairings();
  const c = normaliseCode(code);
  if (c.length !== 8) return null;
  const row = findPairingByCodeHash(tokenHash(c));
  if (!row) return null;
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const updated = updatePairing(row.id, { status: "paired", token_hash: tokenHash(token), expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(), paired_at: new Date().toISOString(), ip })!;
  addAudit({ actor: ip, action: "signin.pairing_exchanged", target: row.platform, detail: `pairing #${row.id}` });
  log.info(`pairing #${row.id} for ${row.platform}: a computer at ${ip} paired; waiting for the sign-in`);
  announce(updated);
  return { token, row: updated };
}

/** The pairing behind a request's bearer token, if it is a live pairing token. */
export function pairingFromRequest(req: IncomingMessage): PairingRow | undefined {
  const b = bearer(req);
  if (!b || !b.startsWith(TOKEN_PREFIX)) return undefined;
  expirePairings();
  return findPairingByTokenHash(tokenHash(b));
}

export function markImporting(id: number) {
  const row = updatePairing(id, { status: "importing" });
  if (row) announce(row);
}

/** Any completed attempt ends the pairing; its token is gone whatever the outcome. */
export function finishPairing(id: number, status: "done" | "failed", detail: string | null = null): PairingRow | undefined {
  const row = updatePairing(id, { status, detail, token_hash: null, finished_at: new Date().toISOString() });
  if (!row) return undefined;
  if (status === "failed") addAudit({ actor: "system", action: "signin.pairing_failed", target: row.platform, detail: detail ?? `pairing #${id}` });
  log.info(`pairing #${id} for ${row.platform} ${status}${detail ? `: ${detail}` : ""}`);
  announce(row);
  return row;
}

export function cancelPairing(platform: string): boolean {
  expirePairings();
  const latest = latestPairing(platform);
  if (!latest || !["waiting", "paired", "importing"].includes(latest.status)) return false;
  const row = updatePairing(latest.id, { status: "cancelled", token_hash: null, finished_at: new Date().toISOString() })!;
  addAudit({ actor: "you", action: "signin.pairing_cancelled", target: platform, detail: `pairing #${row.id}` });
  announce(row);
  return true;
}

/** The pairing a provider's card should show: one in progress, or one that just finished. */
export function activePairing(platform: string): PairingView | null {
  expirePairings();
  const latest = latestPairing(platform);
  if (!latest) return null;
  if (["waiting", "paired", "importing"].includes(latest.status)) return view(latest);
  if ((latest.status === "done" || latest.status === "failed") && latest.finished_at && Date.now() - new Date(latest.finished_at).getTime() < OUTCOME_VISIBLE_MS) return view(latest);
  return null;
}

export function pairingById(id: number): PairingView | null {
  const row = getPairing(id);
  return row ? view(row) : null;
}

/** The import route: a pairing token made for this very provider, or the admin. */
export function requirePairingFor(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  const row = pairingFromRequest(req);
  if (!row) return res.status(401).json({ error: "unauthorized: this needs a live pairing token from the app (make a new code there)" });
  if (row.platform !== req.params.id) return res.status(403).json({ error: `that code was made for ${row.platform}, not ${req.params.id}` });
  res.locals.pairing = row;
  next();
}
