import "../helpers/env.js";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";

const auth = await import("../../src/auth.js");
const db = await import("../../src/db.js");

const req = (headers: Record<string, string> = {}): IncomingMessage => ({ headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;

describe("sessions", () => {
  it("first run creates the password and the ingest token; a login makes a random, revocable session", () => {
    assert.equal(auth.setupRequired(), true);
    assert.ok(auth.createAdminPassword("correct horse battery"));
    assert.equal(auth.createAdminPassword("again"), false);
    assert.ok(auth.ingestToken().length >= 40);
    assert.equal(auth.verifyAdmin("wrong"), false);
    assert.equal(auth.verifyAdmin("correct horse battery"), true);

    const t1 = auth.createSession(req({ "user-agent": "test" }));
    const t2 = auth.createSession(req());
    assert.notEqual(t1, t2, "every login gets its own token");
    assert.equal(db.countSessions(), 2);
    assert.ok(!db.db.prepare("SELECT token_hash FROM sessions").all().some((r: any) => r.token_hash === t1), "only the hash is stored");
    assert.equal(auth.isAdmin(req({ cookie: `acp_session=${t1}` })), true);
    assert.equal(auth.isAdmin(req({ cookie: `acp_session=${t1}x` })), false);
    assert.equal(auth.isAdmin(req({ cookie: "acp_session=" })), false);
    assert.equal(auth.isAdmin(req({ authorization: "Bearer correct horse battery" })), true, "scripts may use the password as a bearer token");
    assert.equal(auth.isAdmin({ headers: {}, query: { token: "correct horse battery" } } as unknown as IncomingMessage), false, "a token in the URL is never accepted");

    assert.ok(auth.revokeSession(req({ cookie: `acp_session=${t1}` })));
    assert.equal(auth.isAdmin(req({ cookie: `acp_session=${t1}` })), false);
    assert.equal(auth.isAdmin(req({ cookie: `acp_session=${t2}` })), true);
  });

  it("changing the password signs every session out", () => {
    const t = auth.createSession(req());
    assert.equal(auth.changeAdminPassword("wrong", "new password 12345"), false);
    assert.ok(auth.changeAdminPassword("correct horse battery", "new password 12345"));
    assert.equal(auth.isAdmin(req({ cookie: `acp_session=${t}` })), false);
    assert.equal(db.countSessions(), 0);
    assert.ok(auth.verifyAdmin("new password 12345"));
    assert.ok(db.listAudit({ action: "auth." }).some((a) => a.action === "auth.password_changed"));
  });

  it("expired sessions are not accepted", () => {
    const t = auth.createSession(req());
    db.db.prepare("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    assert.equal(auth.isAdmin(req({ cookie: `acp_session=${t}` })), false);
  });

  it("recognises a foreign Origin", () => {
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com", origin: "https://cp.example.com" })), false);
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com" })), false, "no Origin header: a plain request, not a browser page");
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com", origin: "https://evil.example.net" })), true);
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com", origin: "null" })), true);
  });
});
