/**
 * The deployment holds signed-in browser sessions, so the edges must hold: no login without the
 * password, no token in URLs, no cross-origin socket, a limit on guesses, headers on the pages.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { startServer, type TestServer } from "../helpers/server.js";

describe("security edges", { timeout: 300_000 }, () => {
  let s: TestServer;
  before(async () => {
    s = await startServer({ BROWSER_ENABLED: "false" });
  });
  after(async () => {
    await s?.stop();
  });

  it("rejects a token in the query string and unauthenticated API calls", async () => {
    const r1 = await fetch(`${s.base}/api/home?token=test-password-123`);
    assert.equal(r1.status, 401);
    const r2 = await fetch(`${s.base}/api/home`);
    assert.equal(r2.status, 401);
    const r3 = await fetch(`${s.base}/api/home`, { headers: { authorization: "Bearer test-password-123" } });
    assert.equal(r3.status, 200, "the password works as a bearer token for scripts");
  });

  it("issues a random session on login, and logout revokes it", async () => {
    const login = await fetch(`${s.base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password-123" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /acp_session=[A-Za-z0-9_-]{30,};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const c = cookie.split(";")[0];
    assert.notEqual(c, s.cookie, "each login is a different token");
    assert.equal((await fetch(`${s.base}/api/home`, { headers: { cookie: c } })).status, 200);
    await fetch(`${s.base}/api/session`, { method: "DELETE", headers: { cookie: c } });
    assert.equal((await fetch(`${s.base}/api/home`, { headers: { cookie: c } })).status, 401, "revoked after logout");
    assert.equal((await fetch(`${s.base}/api/home`, { headers: { cookie: s.cookie } })).status, 200, "other sessions unaffected");
  });

  it("limits password guesses", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${s.base}/api/session`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ password: `guess-${i}` }) });
      last = r.status;
    }
    assert.equal(last, 429);
    const audit = await s.api("/audit?action=ratelimit");
    assert.ok(audit.some((a: any) => a.action === "ratelimit.login"));
    const failed = await s.api("/audit?action=auth.login_failed");
    assert.ok(failed.length >= 10);
  });

  it("refuses a cross-origin live socket and accepts a same-origin one", async () => {
    const outcome = (headers: Record<string, string>) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(s.base).port}/live`, { headers });
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("error", () => resolve("refused"));
      ws.on("unexpected-response", (_req, res) => resolve(`refused:${res.statusCode}`));
    });
    assert.equal(await outcome({ cookie: s.cookie, origin: "https://evil.example.net" }), "refused:403");
    assert.equal(await outcome({ cookie: s.cookie, origin: s.base }), "open");
    assert.equal(await outcome({ cookie: s.cookie }), "open", "non-browser clients send no Origin");
  });

  it("serves the app with security headers and a content-security policy", async () => {
    const r = await fetch(`${s.base}/`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const api = await fetch(`${s.base}/api/setup`);
    assert.equal(api.headers.get("content-security-policy"), null, "API responses carry no page policy");
  });

  it("writes an audit trail for sensitive actions", async () => {
    await s.api("/settings/approval", { method: "PUT", body: { approvalMode: "manual" } });
    await s.api("/policies/send_message", { method: "PUT", body: { mode: "always" } });
    const audit = await s.api("/audit?limit=50");
    for (const a of ["auth.login", "policy.preset", "policy.set"]) assert.ok(audit.some((x: any) => x.action === a), `no ${a} entry`);
  });
});
