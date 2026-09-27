/**
 * Split mode: the api process only enqueues; a separate worker process executes through the
 * shared Postgres queue — including the browser, the approval parking, and the resume.
 * Needs TEST_PG_URL; skipped otherwise.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { MOCK_SELECTORS, startMockProvider } from "../helpers/mock-provider.js";
import { listenSse, startServer, startWorker, waitFor } from "../helpers/server.js";

describe("split roles: api enqueues, a worker executes", { skip: !process.env.TEST_PG_URL && "needs TEST_PG_URL", timeout: 300_000 }, () => {
  it("chat flows through the queue to the worker's browser; approvals park and resume across processes", async () => {
    // One database for both processes; the helper derives it from a shared name.
    const pg = await import("pg");
    const admin = new pg.default.Client({ connectionString: process.env.TEST_PG_URL });
    await admin.connect();
    const dbName = `acp_split_${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 10)}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(process.env.TEST_PG_URL!);
    url.pathname = `/${dbName}`;
    const DATABASE_URL = url.toString();

    const REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:56379";
    const mock = await startMockProvider();
    // The api serves HTTP and must NOT execute; the worker holds the browser.
    const api = await startServer({ ROLE: "api", DATABASE_URL, REDIS_URL, BROWSER_ENABLED: "false" });
    const worker = await startWorker({ DATABASE_URL, REDIS_URL });
    try {
      await api.api("/connections", { body: { name: "Mock AI", appUrl: mock.url, purpose: "testing" } });
      await api.api("/connections/mock-ai", { method: "PUT", body: { ...MOCK_SELECTORS, chatUrl: mock.url } });
      const sse = await listenSse(api);

      // Auto mode: enqueue on the api, execute on the worker, reply lands back in the thread.
      const r = await api.api("/chat", { body: { text: "Hello across processes", platform: "mock-ai" } });
      const done = await waitFor(async () => {
        const m = (await api.api(`/conversations/${r.conversation.id}`)).messages.find((x: any) => x.id === r.message.id);
        return ["done", "failed", "cancelled"].includes(m.status) ? m : null;
      }, 120_000);
      assert.ok(done, "the message settles");
      assert.equal(done.status, "done", `worker delivered it (got ${done.status}: ${done.error ?? ""})`);
      assert.ok(done.response, "the reply came back through the shared database");
      // The worker's execution reached the api's OPEN stream through the redis bridge.
      sse.stop();
      assert.ok(sse.events.some((e) => e.ev === "run-event"), "step events crossed instances");
      assert.ok(sse.events.some((e) => e.ev === "run" && e.data?.status === "success"), "the run's completion crossed instances");
      assert.ok(sse.events.some((e) => e.ev === "msg" && e.data?.id === r.message.id && e.data?.status === "done"), "the settled message crossed instances");

      // Manual mode: the run parks on the worker; the decision on the api resumes it there.
      await api.api("/settings/approval", { method: "PUT", body: { approvalMode: "manual" } });
      const p = await api.api("/chat", { body: { text: "Ask me first, please", conversation_id: r.conversation.id } });
      const pending = await waitFor(async () => (await api.api("/approvals")).pending.find((a: any) => a.messageId === p.message.id), 60_000);
      assert.ok(pending, "the approval parked");
      await api.api(`/approvals/${pending.id}/decide`, { body: { decision: "approve" } });
      const resumed = await waitFor(async () => {
        const m = (await api.api(`/conversations/${r.conversation.id}`)).messages.find((x: any) => x.id === p.message.id);
        return ["done", "failed", "cancelled"].includes(m.status) ? m : null;
      }, 120_000);
      assert.equal(resumed?.status, "done", `the resume executed on the worker (got ${resumed?.status}: ${resumed?.error ?? ""})`);
    } finally {
      await worker.stop();
      await api.stop();
      await mock.close();
    }
  });
});
