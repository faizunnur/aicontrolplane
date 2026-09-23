/**
 * End to end: signing in from your own computer. The app hands out a code, an unauthenticated
 * helper trades it for a scoped token, hands over a session for a mock site that decides sign-in
 * by cookie, and the cloud browser is connected afterwards.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MOCK_SELECTORS, startMockProvider, type MockProvider } from "../helpers/mock-provider.js";
import { listenSse, startServer, waitFor, type TestServer } from "../helpers/server.js";

describe("sign in from your own computer", { timeout: 300_000 }, () => {
  let mock: MockProvider;
  let s: TestServer;
  let sse: Awaited<ReturnType<typeof listenSse>>;
  const cookie = { name: "mock_session", value: "ok", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" };

  before(async () => {
    mock = await startMockProvider();
    s = await startServer();
    sse = await listenSse(s);
    await s.api("/connections", { body: { name: "Mock AI", appUrl: mock.url, purpose: "testing the connect flow" } });
    await s.api("/connections/mock-ai", { method: "PUT", body: { ...MOCK_SELECTORS, chatUrl: mock.url, sessionCookie: "mock_session", cookieDomain: "127.0.0.1" } });
    mock.setCookieGate(true);
  });
  after(async () => {
    try {
      sse?.stop();
    } catch {
      /* closed */
    }
    try {
      await s?.stop();
    } catch {
      /* gone */
    }
    await mock?.close().catch(() => undefined);
  });

  it("hands a session captured elsewhere to the cloud browser through a code and a scoped token", async () => {
    assert.equal((await s.api("/connections/mock-ai/check", { body: {} })).status, "needs_login", "without the cookie the site shows the sign-in page");

    const made = await s.api("/connections/mock-ai/pairing", { body: {} });
    assert.match(made.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(made.secure, true, "loopback counts as safe for the helper");
    // A computer with no copy of the project fetches the helper from the deployment itself.
    assert.equal(made.connect.helperUrl, `${s.base}/connect.mjs`);
    // Two lines with curl.exe: the one form that runs in Command Prompt and in PowerShell alike.
    assert.match(made.connect.windows, /^curl\.exe -fsSL http:\/\/127\.0\.0\.1:\d+\/connect\.mjs -o acp-connect\.mjs\nnode acp-connect\.mjs http:\/\/127\.0\.0\.1:\d+ [A-Z2-9-]+$/);
    assert.match(made.connect.unix, /^curl -fsSL http:\/\/127\.0\.0\.1:\d+\/connect\.mjs -o acp-connect\.mjs && node acp-connect\.mjs http:\/\/127\.0\.0\.1:\d+ [A-Z2-9-]+$/);
    assert.match(made.connect.repo, /^npm run connect -- http:\/\/127\.0\.0\.1:\d+ [A-Z2-9-]+$/);
    const helper = await s.raw("/connect.mjs", { headers: { cookie: "" } });
    assert.equal(helper.status, 200, "the helper downloads without a password: it holds no secrets");
    const source = await helper.text();
    assert.ok(source.includes("/api/pairing/exchange") && source.includes("--remote-debugging-port"), "and it is the helper");
    assert.ok(!/import .* from "(?!node:)/.test(source), "with nothing to install: only Node's own modules");
    assert.equal((await s.api("/connections/mock-ai/pairing")).status, "waiting");
    const card = (await s.api("/connections")).find((c: any) => c.id === "mock-ai");
    assert.equal(card.pairing?.status, "waiting", "the connection card carries the pairing");

    // The helper has neither the password nor a cookie.
    const ex = await s.raw("/api/pairing/exchange", { method: "POST", headers: { cookie: "", "content-type": "application/json" }, body: JSON.stringify({ code: made.code.toLowerCase() }) });
    assert.equal(ex.status, 200);
    const got = await ex.json();
    assert.ok(got.token.startsWith("acp_pair_"));
    assert.deepEqual(got.platform.domains, ["127.0.0.1"]);
    assert.equal(got.platform.sessionCookie, "mock_session");
    assert.equal(got.importPath, "/api/connections/mock-ai/import-session");
    const again = await s.raw("/api/pairing/exchange", { method: "POST", headers: { cookie: "", "content-type": "application/json" }, body: JSON.stringify({ code: made.code }) });
    assert.equal(again.status, 404, "a code is single use");

    const bearer = { cookie: "", authorization: `Bearer ${got.token}`, "content-type": "application/json" };
    assert.equal((await s.raw("/api/home", { headers: bearer })).status, 401, "the token opens nothing else");
    assert.equal((await s.raw("/api/connections/chatgpt/import-session", { method: "POST", headers: bearer, body: JSON.stringify({ cookies: [cookie] }) })).status, 403, "nor another provider");
    const empty = await s.raw("/api/connections/mock-ai/import-session", { method: "POST", headers: bearer, body: JSON.stringify({ cookies: [{ ...cookie, domain: "example.com" }] }) });
    assert.equal(empty.status, 400, "cookies for other domains are not a session");

    const imp = await s.raw("/api/connections/mock-ai/import-session", { method: "POST", headers: bearer, body: JSON.stringify({ cookies: [cookie], origins: [{ origin: mock.url.replace(/\/$/, ""), localStorage: [{ name: "acp_test", value: "1" }] }], helper: { version: "test", os: "test" } }) });
    const impText = await imp.text();
    assert.equal(imp.status, 200, impText);
    const r = JSON.parse(impText);
    assert.equal(r.status, "logged_in");
    assert.equal(r.ok, true);
    assert.equal(r.imported.cookies, 1);
    assert.equal(r.imported.origins, 1);

    const after = (await s.api("/connections")).find((c: any) => c.id === "mock-ai");
    assert.equal(after.status, "logged_in");
    assert.equal(after.signInMode, "local", "what worked is remembered as the way to sign in next time");
    assert.equal(after.pairing?.status, "done");
    assert.equal((await s.raw("/api/connections/mock-ai/import-session", { method: "POST", headers: bearer, body: JSON.stringify({ cookies: [cookie] }) })).status, 401, "the token died with the import");

    const audit = await s.api("/audit?action=signin.");
    for (const a of ["signin.pairing_created", "signin.pairing_exchanged", "signin.imported_from_computer"]) assert.ok(audit.some((x: any) => x.action === a), `audit has ${a}`);
    const seen = await waitFor(async () => (sse.events.filter((e) => e.ev === "pairing").some((e) => e.data.status === "done") ? true : null), 10_000);
    assert.ok(seen, "the stream told the page about each step");
    const statuses = sse.events.filter((e) => e.ev === "pairing" && e.data.id === made.id).map((e) => e.data.status);
    assert.deepEqual(statuses, ["waiting", "paired", "importing", "done"]);
  });

  it("builds the command from PUBLIC_URL, so nobody has to edit an address by hand", async () => {
    // A bare domain with a trailing slash: what people actually paste into a deployment's variables.
    const pinned = await startServer({ PUBLIC_URL: "acp.example.test/" });
    try {
      const made = await pinned.api("/connections/chatgpt/pairing", { body: {} });
      assert.equal(made.publicUrl, "https://acp.example.test");
      assert.equal(made.publicUrlSource, "env");
      assert.equal(made.secure, true);
      assert.equal(made.connect.helperUrl, "https://acp.example.test/connect.mjs");
      assert.equal(made.connect.unix, `curl -fsSL https://acp.example.test/connect.mjs -o acp-connect.mjs && node acp-connect.mjs https://acp.example.test ${made.code}`);
      assert.equal(made.connect.windows, `curl.exe -fsSL https://acp.example.test/connect.mjs -o acp-connect.mjs\nnode acp-connect.mjs https://acp.example.test ${made.code}`);
      assert.equal(made.connect.repo, `npm run connect -- https://acp.example.test ${made.code}`);
      assert.equal((await pinned.api("/diagnostics")).publicUrlSource, "env");
    } finally {
      await pinned.stop();
    }
  });

  it("rate-limits code guessing and lets a waiting code be cancelled", async () => {
    const guesser = { cookie: "", "content-type": "application/json", "x-forwarded-for": "203.0.113.9" };
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await s.raw("/api/pairing/exchange", { method: "POST", headers: guesser, body: JSON.stringify({ code: "AAAA-AAAA" }) })).status;
    assert.equal(last, 429);
    const made = await s.api("/connections/mock-ai/pairing", { body: {} });
    assert.equal((await s.api("/connections/mock-ai/pairing")).id, made.id);
    const cancelled = await s.api("/connections/mock-ai/pairing", { method: "DELETE" });
    assert.equal(cancelled.ok, true);
    assert.equal((await s.raw("/api/pairing/exchange", { method: "POST", headers: { cookie: "", "content-type": "application/json" }, body: JSON.stringify({ code: made.code }) })).status, 404);
  });
});
