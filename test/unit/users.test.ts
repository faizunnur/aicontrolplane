import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const auth = await import("../../src/auth.js");

describe("real user accounts", () => {
  it("setup creates the owner; logins resolve with and without an email while there is one user", async () => {
    assert.equal(await auth.setupRequired(), true);
    assert.ok(await auth.createAdminPassword("first-password-1", "owner@example.test"));
    assert.equal(await auth.setupRequired(), false);
    const noEmail = await auth.verifyUser("first-password-1");
    assert.equal(noEmail?.email, "owner@example.test");
    assert.equal(noEmail?.role, "owner");
    const withEmail = await auth.verifyUser("first-password-1", "OWNER@example.test");
    assert.equal(withEmail?.email, "owner@example.test", "emails are case-insensitive");
    assert.equal(await auth.verifyUser("wrong-password"), null);
  });

  it("a second account makes the email mandatory, and each signs in with their own password", async () => {
    await db.createUser({ email: "second@example.test", password_hash: await auth.hashPassword("second-password-2"), role: "member" });
    assert.equal(await auth.verifyUser("first-password-1"), null, "ambiguous without an email now");
    assert.equal((await auth.verifyUser("first-password-1", "owner@example.test"))?.role, "owner");
    assert.equal((await auth.verifyUser("second-password-2", "second@example.test"))?.role, "member");
    assert.equal(await auth.verifyUser("second-password-2", "owner@example.test"), null, "passwords are per account");
  });

  it("a migrated sha256 hash verifies and upgrades itself to argon2 on login", async () => {
    const legacy = await db.createUser({ email: "legacy@example.test", password_hash: `sha256:${auth.tokenHash("old-pass-123")}`, role: "member" });
    const who = await auth.verifyUser("old-pass-123", "legacy@example.test");
    assert.equal(who?.id, legacy.id);
    const after = (await db.getUser(legacy.id))!;
    assert.ok(after.password_hash.startsWith("$argon2"), "hash upgraded in place");
    assert.ok(await auth.verifyPassword(after.password_hash, "old-pass-123"));
  });

  it("sessions carry their user, and deleting the account kills them", async () => {
    const u = await db.createUser({ email: "gone@example.test", password_hash: await auth.hashPassword("gone-password-3") });
    const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as import("node:http").IncomingMessage;
    const token = await auth.createSession(req, { id: u.id, email: u.email, role: u.role, orgId: u.org_id });
    const authed = { headers: { cookie: `acp_session=${token}` } } as unknown as import("node:http").IncomingMessage;
    assert.equal((await auth.authUser(authed))?.email, "gone@example.test");
    await db.deleteSessionsForUser(u.id);
    await db.deleteUser(u.id);
    assert.equal(await auth.authUser(authed), null, "the session died with the account");
  });
});
