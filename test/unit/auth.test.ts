import "../helpers/env.js";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";

const auth = await import("../../src/auth.js");
const db = await import("../../src/db.js");

const req = (headers: Record<string, string> = {}): IncomingMessage => ({ headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;

describe("sessions", () => {
  it("first run creates the password; the ingest token is minted by rotation and only its hash is kept", async () => {
    assert.equal(await auth.setupRequired(), true);
    assert.ok(await auth.createAdminPassword("correct horse battery"));
    assert.equal(await auth.createAdminPassword("again"), false);
    await db.withOrg(1, async () => {
      assert.equal(await auth.ingestTokenSet(1), false, "nothing is minted at setup - a hash-only token could never be shown");
      const minted = await auth.rotateIngestToken(1);
      assert.ok(minted.length >= 40);
      assert.equal(await auth.ingestTokenSet(1), true);
      assert.ok(!(await db.rawAll<{ value: string }>("SELECT value FROM settings WHERE key = 'ingest_token'")).some((r) => r.value === minted), "only the hash is stored");
    });
    assert.equal(await auth.verifyAdmin("wrong"), false);
    assert.equal(await auth.verifyAdmin("correct horse battery"), true);

    const t1 = await auth.createSession(req({ "user-agent": "test" }));
    const t2 = await auth.createSession(req());
    assert.notEqual(t1, t2, "every login gets its own token");
    assert.equal(await db.countSessions(), 2);
    assert.ok(!(await db.rawAll<{ token_hash: string }>("SELECT token_hash FROM sessions")).some((r) => r.token_hash === t1), "only the hash is stored");
    assert.equal(await auth.isAdmin(req({ cookie: `acp_session=${t1}` })), true);
    assert.equal(await auth.isAdmin(req({ cookie: `acp_session=${t1}x` })), false);
    assert.equal(await auth.isAdmin(req({ cookie: "acp_session=" })), false);
    assert.equal(await auth.isAdmin(req({ authorization: "Bearer correct horse battery" })), true, "scripts may use the password as a bearer token");
    assert.equal(await auth.isAdmin({ headers: {}, query: { token: "correct horse battery" } } as unknown as IncomingMessage), false, "a token in the URL is never accepted");

    assert.ok(await auth.revokeSession(req({ cookie: `acp_session=${t1}` })));
    assert.equal(await auth.isAdmin(req({ cookie: `acp_session=${t1}` })), false);
    assert.equal(await auth.isAdmin(req({ cookie: `acp_session=${t2}` })), true);
  });

  it("changing the password signs every session out and evicts the old bearer credential at once", async () => {
    // Warm the bearer cache with the old password: without eviction it would keep working
    // for up to 30 seconds after the change.
    assert.ok(await auth.isAdmin(req({ authorization: "Bearer correct horse battery" })));
    const t = await auth.createSession(req());
    assert.equal(await auth.changeAdminPassword("wrong", "new password 12345"), false);
    assert.ok(await auth.changeAdminPassword("correct horse battery", "new password 12345"));
    assert.equal(await auth.isAdmin(req({ cookie: `acp_session=${t}` })), false);
    assert.equal(await db.countSessions(), 0);
    assert.equal(await auth.isAdmin(req({ authorization: "Bearer correct horse battery" })), false, "the old password dies with the change, cache included");
    assert.ok(await auth.verifyAdmin("new password 12345"));
    assert.ok((await db.listAudit({ action: "auth." })).some((a) => a.action === "auth.password_changed"));
  });

  it("ignores X-Forwarded-For unless TRUST_PROXY says whose proxy stands in front", () => {
    // The test env sets no TRUST_PROXY, so the spoofable header must not move the address.
    assert.equal(auth.clientIp(req({ "x-forwarded-for": "203.0.113.9" })), "127.0.0.1");
    assert.equal(auth.clientIp(req()), "127.0.0.1");
  });

  it("expired sessions are not accepted", async () => {
    const t = await auth.createSession(req());
    await db.rawRun("UPDATE sessions SET expires_at = ?", [new Date(Date.now() - 1000).toISOString()]);
    assert.equal(await auth.isAdmin(req({ cookie: `acp_session=${t}` })), false);
  });

  it("recognises a foreign Origin", () => {
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com", origin: "https://cp.example.com" })), false);
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com" })), false, "no Origin header: a plain request, not a browser page");
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com", origin: "https://evil.example.net" })), true);
    assert.equal(auth.crossOrigin(req({ host: "cp.example.com", origin: "null" })), true);
  });
});
