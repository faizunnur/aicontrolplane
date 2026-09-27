/**
 * The flagship durability test: a server restart while an approval is pending loses NOTHING.
 * Boots the server, gets a message parked on its approval, kills the server, boots it again
 * on the same data folder, approves — and the run resumes and completes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MOCK_SELECTORS, startMockProvider } from "../helpers/mock-provider.js";
import { startServer, waitFor } from "../helpers/server.js";

describe("restart with a pending approval", { timeout: 300_000 }, () => {
  it("keeps the approval waiting across the restart; approving afterwards resumes and completes the run", async () => {
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
      assert.equal((await s.api(`/runs/${runId}`)).status, "waiting_approval", "the run parked durably, holding nothing");

      await s.stop({ keepData: true });
      s = await startServer({}, { dataDir });

      // Nothing was lost: the approval still waits, the run is still parked.
      const approvals = await s.api("/approvals");
      assert.equal(approvals.pending.find((a: any) => a.id === waiting.id)?.status, "pending", "the approval survives the restart");
      assert.equal((await s.api(`/runs/${runId}`)).status, "waiting_approval");
      assert.equal((await s.api("/settings/approval")).approvalMode, "manual", "the preset survives the restart");

      // Approving now — after a full restart — resumes the run, which sends and completes.
      await s.api(`/approvals/${waiting.id}/decide`, { body: { decision: "approve" } });
      const finished = await waitFor(
        async () => {
          const run = await s.api(`/runs/${runId}`);
          return ["success", "failed", "cancelled", "needs_attention", "timed_out"].includes(run.status) ? run : null;
        },
        120_000,
      );
      assert.ok(finished, "the resumed run settles");
      assert.equal(finished.status, "success", `the resumed run completes (got: ${finished.status} ${finished.error ?? ""})`);
      assert.equal(finished.steps.find((st: any) => st.key === "approve")?.status, "done");
      const m = await waitFor(async () => {
        const row = (await s.api(`/conversations/${cid}`)).messages.find((x: any) => x.id === mid);
        return row.status === "done" ? row : null;
      }, 30_000);
      assert.ok(m, "the message settles as done with the reply");
      assert.ok(m.response, "the reply came back after the restart");
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
