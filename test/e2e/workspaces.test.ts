/**
 * The multi-tenant flagship: two people sign up, verify by email (stub SMTP writes the mails
 * to disk), and get private workspaces. Whatever one workspace does — messages, tasks pushed
 * by its agents, live events — the other never sees: not in lists, not by id, not on the
 * stream, not through ingest tokens. Needs TEST_PG_URL; skipped otherwise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { startServer, waitFor } from "../helpers/server.js";

function mailFor(dataDir: string, to: string): { subject: string; text: string } {
  const dir = path.join(dataDir, "mail-outbox");
  const mails = fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { to: string; subject: string; text: string })
    .filter((m) => m.to === to);
  assert.ok(mails.length > 0, `no mail for ${to}`);
  return mails.at(-1)!;
}
function linkToken(text: string, param: string): string {
  const m = new RegExp(`[?&]${param}=([A-Za-z0-9_-]+)`).exec(text);
  assert.ok(m, `no ${param} link in mail: ${text}`);
  return m![1];
}

describe("workspaces: sign-up, verification, isolation", { skip: !process.env.TEST_PG_URL && "needs TEST_PG_URL", timeout: 300_000 }, () => {
  it("two sign-ups become two private workspaces that cannot see each other", async () => {
    const server = await startServer({ SMTP_HOST: "stub", BROWSER_ENABLED: "false" });
    const asUser = (cookie: string) => ({
      api: async <T = unknown>(p: string, opts: { method?: string; body?: unknown } = {}): Promise<T> => {
        const res = await fetch(`${server.base}/api${p}`, {
          method: opts.method ?? (opts.body ? "POST" : "GET"),
          headers: { cookie, "content-type": "application/json" },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        if (!res.ok) throw Object.assign(new Error(`${p} -> ${res.status}`), { status: res.status });
        return (await res.json()) as T;
      },
      status: async (p: string): Promise<number> => (await fetch(`${server.base}/api${p}`, { headers: { cookie } })).status,
    });
    const signup = async (email: string, password: string): Promise<ReturnType<typeof asUser> & { cookie: string }> => {
      const r = await fetch(`${server.base}/api/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      assert.equal(r.status, 200, `signup ${email}`);
      const token = linkToken(mailFor(server.dataDir, email).text, "token");
      // Before the link is clicked, the password does not open anything.
      const early = await fetch(`${server.base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      assert.equal(early.status, 401);
      assert.equal((await early.json()).unverified, true, "told to check the inbox");
      const verify = await fetch(`${server.base}/api/verify?token=${token}`, { redirect: "manual" });
      assert.equal(verify.status, 302, "verify redirects home");
      const cookie = verify.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie, "verifying signs you in");
      return { ...asUser(cookie!), cookie: cookie! };
    };
    /** A raw SSE listener with a specific user's cookie. */
    const listen = async (cookie: string) => {
      const ctrl = new AbortController();
      const res = await fetch(`${server.base}/api/stream`, { headers: { cookie }, signal: ctrl.signal });
      const events: { ev: string; data: unknown }[] = [];
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /^event: (.*)$/m.exec(chunk)?.[1];
              const data = /^data: (.*)$/m.exec(chunk)?.[1];
              if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
            }
          }
        } catch {
          /* aborted */
        }
      })();
      return { events, stop: () => ctrl.abort() };
    };

    try {
      // Sign-up is enabled: Postgres + stub SMTP.
      assert.equal((await fetch(`${server.base}/api/signup/status`).then((r) => r.json())).enabled, true);

      const alice = await signup("alice@example.test", "alice-password-1");
      const bob = await signup("bob@example.test", "bob-password-22");

      // A used verification link is dead.
      const aliceMail = mailFor(server.dataDir, "alice@example.test");
      const again = await fetch(`${server.base}/api/verify?token=${linkToken(aliceMail.text, "token")}`, { redirect: "manual" });
      assert.equal(again.headers.get("location"), "/?verify=failed", "a verify link works exactly once");

      // Alice furnishes her workspace: a chat message and an agent-reported task run.
      const conv = await alice.api<{ id: number }>("/conversations", { body: {} });
      await alice.api("/messages", { body: { text: "hello from alice", conversation_id: conv.id } });
      // Settings only says a token exists; rotation is where the plaintext is handed out.
      const aliceToken = (await alice.api<{ ingestToken: string }>("/settings/ingest-token/rotate", { method: "POST" })).ingestToken;
      const ingest = await fetch(`${server.base}/api/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: { key: "alice-audit", platform: "custom", name: "Alice audit" }, profile: { key: "alice-bot" }, run: { status: "success", summary: "1 thing done" } }),
      });
      assert.equal(ingest.status, 200);
      const aliceRuns = await alice.api<unknown[]>("/runs?limit=50");
      assert.ok(aliceRuns.length >= 1, "alice sees her run");
      const aliceTasks = await alice.api<{ id: number; name: string }[]>("/tasks");
      const aliceTask = aliceTasks.find((t) => t.name === "Alice audit");
      assert.ok(aliceTask, "alice sees her task");

      // Bob's workspace is empty of all of it: lists, ids, counters.
      const bobHome = await bob.api<{ conversations: unknown[] }>("/home");
      assert.equal(bobHome.conversations.length, 0, "bob has no conversations");
      assert.equal((await bob.api<unknown[]>("/runs?limit=50")).length, 0, "bob has no runs");
      assert.equal((await bob.api<unknown[]>("/tasks")).length, 0, "bob has no tasks");
      assert.equal(await bob.status(`/conversations/${conv.id}`), 404, "alice's thread is a 404 for bob");
      assert.equal(await bob.status(`/tasks/${aliceTask!.id}`), 404, "alice's task is a 404 for bob");

      // Bob's ingest token is his own workspace's, not alice's.
      const bobToken = (await bob.api<{ ingestToken: string }>("/settings/ingest-token/rotate", { method: "POST" })).ingestToken;
      assert.notEqual(bobToken, aliceToken, "each workspace has its own agent token");
      await fetch(`${server.base}/api/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: { key: "bob-job", platform: "custom", name: "Bob job" }, run: { status: "success", summary: "bob did a thing" } }),
      });
      assert.ok(!(await alice.api<{ name: string }[]>("/tasks")).some((t) => t.name === "Bob job"), "bob's task never appears for alice");

      // The live stream: bob's page hears his own workspace and stays silent about alice's.
      const bobStream = await listen(bob.cookie);
      await alice.api("/messages", { body: { text: "alice's secret", conversation_id: conv.id } });
      const bobConv = await bob.api<{ id: number }>("/conversations", { body: {} });
      await bob.api("/messages", { body: { text: "bob's own note", conversation_id: bobConv.id } });
      const own = await waitFor(async () => bobStream.events.some((e) => e.ev === "msg" && JSON.stringify(e.data).includes("bob's own note")), 30_000);
      bobStream.stop();
      assert.ok(own, "bob's stream carries his own workspace");
      assert.ok(!bobStream.events.some((e) => JSON.stringify(e.data ?? "").includes("alice")), "nothing of alice's ever reaches bob's stream");
    } finally {
      await server.stop();
    }
  });
});
