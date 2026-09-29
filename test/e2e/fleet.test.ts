/**
 * The browser-fleet flagship: two workspaces drive the SAME provider website through one
 * browser process, each with its own imported session, and the sessions never bleed. With a
 * single context slot, every chat evicts the other workspace's connection (sealed to its
 * blob) and the next chat re-seeds it — hibernation and rewake, proven by the session value
 * the mock echoes into every reply. Needs TEST_PG_URL; skipped otherwise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { MOCK_SELECTORS, startMockProvider } from "../helpers/mock-provider.js";
import { startServer, waitFor } from "../helpers/server.js";

function verifyLink(dataDir: string, to: string): string {
  const dir = path.join(dataDir, "mail-outbox");
  const mails = fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { to: string; text: string })
    .filter((m) => m.to === to);
  const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(mails.at(-1)?.text ?? "");
  assert.ok(m, `no verify link for ${to}`);
  return m![1];
}

describe("browser fleet: one Chrome, private sessions per workspace", { skip: !process.env.TEST_PG_URL && "needs TEST_PG_URL", timeout: 300_000 }, () => {
  it("two workspaces chat through the same site with their own sign-ins; eviction and rewake keep them", async () => {
    const mock = await startMockProvider();
    mock.setCookieGate(true);
    // One context slot: every job for the other workspace evicts (seals) the current one,
    // so session survival across hibernation is exercised on every single chat.
    const server = await startServer({ SMTP_HOST: "stub", BROWSER_FLEET: "ephemeral", BROWSER_MAX_CONTEXTS: "1", BROWSER_ORG_MAX_CONTEXTS: "1" });

    const asUser = (cookie: string) => ({
      cookie,
      api: async <T = any>(p: string, opts: { method?: string; body?: unknown } = {}): Promise<T> => {
        const res = await fetch(`${server.base}/api${p}`, {
          method: opts.method ?? (opts.body ? "POST" : "GET"),
          headers: { cookie, "content-type": "application/json" },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        if (!res.ok) throw Object.assign(new Error(`${p} -> ${res.status}: ${await res.text()}`), { status: res.status });
        return (await res.json()) as T;
      },
    });
    const signup = async (email: string, password: string) => {
      const r = await fetch(`${server.base}/api/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      assert.equal(r.status, 200);
      const verify = await fetch(`${server.base}/api/verify?token=${verifyLink(server.dataDir, email)}`, { redirect: "manual" });
      const cookie = verify.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie, `no session for ${email}`);
      return asUser(cookie!);
    };
    /** Add the mock site as this workspace's provider and hand it that workspace's session cookie. */
    const connectMock = async (user: ReturnType<typeof asUser>, sessionValue: string) => {
      await user.api("/connections", { body: { name: "Mock AI", appUrl: mock.url, purpose: "fleet isolation test" } });
      await user.api("/connections/mock-ai", { method: "PUT", body: { ...MOCK_SELECTORS, chatUrl: mock.url, sessionCookie: "mock_session", cookieDomain: "127.0.0.1" } });
      const made = await user.api<{ code: string }>("/connections/mock-ai/pairing", { body: {} });
      const got = await fetch(`${server.base}/api/pairing/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: made.code }) }).then((r) => r.json());
      const imp = await fetch(`${server.base}/api/connections/mock-ai/import-session`, {
        method: "POST",
        headers: { authorization: `Bearer ${got.token}`, "content-type": "application/json" },
        body: JSON.stringify({ cookies: [{ name: "mock_session", value: sessionValue, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }] }),
      });
      const body = await imp.json();
      assert.equal(imp.status, 200, JSON.stringify(body));
      assert.equal(body.status, "logged_in", `import for ${sessionValue} signs the connection in`);
    };
    const chat = async (user: ReturnType<typeof asUser>, text: string): Promise<string> => {
      const r = await user.api<{ message: { id: number } }>("/chat", { body: { text } });
      const final = await waitFor(async () => {
        const m = await user.api<{ status: string; response: string | null; error: string | null }>(`/messages/${r.message.id}`);
        return m.status === "done" || m.status === "failed" ? m : null;
      }, 120_000);
      assert.ok(final, "the chat settled");
      assert.equal(final!.status, "done", `chat failed: ${final!.error}`);
      return final!.response ?? "";
    };

    try {
      const alice = await signup("alice@fleet.test", "alice-password-1");
      const bob = await signup("bob@fleet.test", "bob-password-22");
      await connectMock(alice, "alice-session");
      await connectMock(bob, "bob-session");

      // Each workspace's chat rides its own cookies through the shared Chrome.
      const a1 = await chat(alice, "hello from alice");
      assert.match(a1, /\[alice-session\] You said: hello from alice/);
      const b1 = await chat(bob, "hello from bob");
      assert.match(b1, /\[bob-session\] You said: hello from bob/);
      assert.ok(!b1.includes("alice"), "nothing of alice's in bob's reply");

      // Bob's chat evicted alice's connection (one slot); her next chat re-seeds from the
      // sealed blob and the session is still hers.
      const a2 = await chat(alice, "back again");
      assert.match(a2, /\[alice-session\] You said: back again/);
      assert.ok(!a2.includes("bob-session"), "nothing of bob's in alice's reply");
    } finally {
      await server.stop();
      await mock.close().catch(() => undefined);
    }
  });
});
