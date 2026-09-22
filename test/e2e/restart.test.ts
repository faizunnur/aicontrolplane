/**
 * A server restart while an approval is pending must surface it, not lose it.
 * Boots the server, gets a message to the "waiting for approval" point, kills the server,
 * boots it again on the same data folder, and checks what the user would see.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MOCK_SELECTORS, startMockProvider } from "../helpers/mock-provider.js";
import { startServer, waitFor } from "../helpers/server.js";

describe("restart with a pending approval", { timeout: 300_000 }, () => {
  it("marks the approval interrupted, fails the run and message visibly, and notifies", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-restart-"));
    const mock = await startMockProvider();
    let s = await startServer({}, { dataDir });
    try {
      await s.api("/connections", { body: { name: "Mock AI", appUrl: mock.url, purpose: "testing" } });
      await s.api("/connections/mock-ai", { method: "PUT", body: { ...MOCK_SELECTORS, chatUrl: mock.url } });
      await s.api("/connections/mock-ai/check", { body: {} });
      await s.api("/settings/approval", { method: "PUT", body: { approvalMode: "manual" } });
      const r = await s.api("/chat", { body: { text: "Please wait for my approval", platform: "mock-ai" } });
      const cid = r.conversation.id;
      const mid = r.message.id;
      const waiting = await waitFor(async () => (await s.api("/approvals")).pending.find((a: any) => a.messageId === mid), 90_000);
      assert.ok(waiting, "an approval is pending");
      const runId = (await s.api(`/conversations/${cid}`)).messages.find((m: any) => m.id === mid).run_id;
      assert.ok(runId);

      await s.stop({ keepData: true });
      s = await startServer({}, { dataDir });

      const approval = await s.api(`/approvals`);
      assert.equal(approval.pending.length, 0, "nothing is silently still pending");
      assert.equal(approval.recent.find((a: any) => a.id === waiting.id)?.status, "interrupted");
      const run = await s.api(`/runs/${runId}`);
      assert.equal(run.status, "needs_attention");
      assert.match(run.error, /restarted/);
      assert.ok(run.steps.find((st: any) => st.key === "approve")?.status === "failed");
      const m = (await s.api(`/conversations/${cid}`)).messages.find((x: any) => x.id === mid);
      assert.equal(m.status, "failed");
      assert.match(m.error, /restarted/);
      const events = await s.api("/events?limit=10");
      assert.ok(events.some((e: any) => e.kind === "approval" && /interrupted/i.test(e.title)));
      assert.equal((await s.api("/settings/approval")).approvalMode, "manual", "the preset survives the restart");
    } finally {
      await s.stop();
      await mock.close();
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* Chromium may still hold profile files for a moment; a leftover temp folder is not a failure */
      }
    }
  });
});
