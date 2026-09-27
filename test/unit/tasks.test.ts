import "../helpers/env.js";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { startTask, listTaskViews, TaskStartError } = await import("../../src/tasks.js");
const { UnsupportedOperationError } = await import("../../src/providers/types.js");
const policy = await import("../../src/policy.js");
const { getProvider } = await import("../../src/providers/registry.js");

/** A tiny HTTP receiver standing in for Claude's fire endpoint or an agent's webhook. */
function receiver(reply: (body: unknown, req: http.IncomingMessage) => { status: number; body: unknown }) {
  const calls: { headers: http.IncomingHttpHeaders; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ headers: req.headers, body });
      const r = reply(body, req);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise<{ url: string; calls: typeof calls; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, calls, close: () => server.close() }));
  });
}

describe("task registry", () => {
  it("shows every task in one shape with provider, agent, runs and what can be done", async () => {
    await policy.setApprovalMode("auto");
    const t = await db.upsertTask({ platform: "chatgpt", key: "daily-briefing", name: "Daily briefing", source: "discovered", schedule: "daily 09:00", next_run: "2026-09-23T09:00:00.000Z" });
    await db.recordRun({ task_id: t.id, external_id: "r1", status: "success", source: "collector", summary: "sent" });
    const view = (await listTaskViews({ platform: "chatgpt" })).find((v) => v.id === t.id)!;
    assert.equal(view.provider.name, "ChatGPT");
    assert.equal(view.result, "sent");
    assert.equal(view.next_run, "2026-09-23T09:00:00.000Z");
    assert.equal(view.can.run, false, "ChatGPT tasks cannot be started from outside");
    assert.match(view.can.run_reason!, /cannot be started/);
    assert.equal(view.can.pause_at_provider, false);
    assert.match(view.can.unsupported.pause_at_provider!, /chatgpt.com\/schedules/);
    assert.deepEqual(view.recent_statuses, ["success"]);
  });

  it("refuses to start a task whose provider or configuration cannot", async () => {
    const chatgpt = await db.upsertTask({ platform: "chatgpt", key: "t-nostart", name: "No start", source: "discovered" });
    await assert.rejects(async () => await startTask(chatgpt.id), UnsupportedOperationError);
    const claude = await db.upsertTask({ platform: "claude", key: "routine-x", name: "Routine X", source: "discovered" });
    await assert.rejects(async () => await startTask(claude.id), (err: unknown) => err instanceof TaskStartError && /fire_url/.test(err.message));
    const custom = await db.upsertTask({ platform: "custom", key: "no-hook", name: "No hook", source: "push" });
    await assert.rejects(async () => await startTask(custom.id), (err: unknown) => err instanceof TaskStartError && /webhook/.test(err.message));
    await assert.rejects(async () => await startTask(999_999), (err: unknown) => err instanceof TaskStartError && err.status === 404);
  });

  it("starts a Claude routine through its fire endpoint with the documented headers", async () => {
    const fire = await receiver(() => ({ status: 200, body: { type: "routine_fire", claude_code_session_id: "session_01X", claude_code_session_url: "https://claude.ai/code/session_01X" } }));
    try {
      await policy.setApprovalMode("auto");
      const t = await db.upsertTask({ platform: "claude", key: "nightly-review", name: "Nightly review", source: "discovered", configuration: { fire_url: fire.url, fire_token: "sk-ant-oat01-test" } });
      const view = (await listTaskViews({ platform: "claude" })).find((v) => v.id === t.id)!;
      assert.equal(view.can.run, true, "a routine with its trigger configured can be started");
      assert.equal(getProvider("claude")!.canRunTask({ id: 0, key: "x", name: "x", configuration: { fire_url: "http://example.com/fire", fire_token: "t" } }).ok, false, "plain http is refused for a real endpoint");
      const run = await startTask(t.id, { text: "alert body" });
      assert.equal(run.status, "success");
      assert.equal(run.kind, "task");
      assert.equal(run.external_id, "session_01X");
      assert.equal(run.output_url, "https://claude.ai/code/session_01X");
      assert.deepEqual(db.foldSteps(await db.runEvents(run.id)).map((s) => `${s.key}:${s.status}`), ["select:done", "start:done", "done:done"]);
      assert.equal(fire.calls.length, 1);
      assert.equal(fire.calls[0].headers.authorization, "Bearer sk-ant-oat01-test");
      assert.equal(fire.calls[0].headers["anthropic-beta"], "experimental-cc-routine-2026-04-01");
      assert.equal(fire.calls[0].headers["anthropic-version"], "2023-06-01");
      assert.deepEqual(fire.calls[0].body, { text: "alert body" });
    } finally {
      fire.close();
    }
  });

  it("starts a custom agent's task through its webhook and leaves the run open for the report", async () => {
    await policy.setApprovalMode("auto");
    const hook = await receiver(() => ({ status: 202, body: { accepted: true } }));
    try {
      const t = await db.upsertTask({ platform: "custom", key: "repo-scan", name: "Repository scan", source: "push", delivery: { mode: "webhook", webhook_url: hook.url, webhook_token: "hook-secret" } });
      const view = (await listTaskViews({ platform: "custom" })).find((v) => v.id === t.id)!;
      assert.equal(view.can.run, true);
      const run = await startTask(t.id, { text: "scan main only" });
      assert.equal(run.status, "running", "open until the agent reports back");
      assert.equal(run.kind, "task");
      assert.equal(hook.calls.length, 1);
      assert.equal(hook.calls[0].headers.authorization, "Bearer hook-secret");
      const body = hook.calls[0].body as { type: string; run_id: number; task: { key: string }; text: string };
      assert.equal(body.type, "run_task");
      assert.equal(body.run_id, run.id);
      assert.equal(body.task.key, "repo-scan");
      assert.equal(body.text, "scan main only");
      const steps = db.foldSteps(await db.runEvents(run.id));
      assert.deepEqual(steps.map((s) => `${s.key}:${s.status}`), ["select:done", "start:done", "report:waiting"]);
      assert.ok(!steps.some((s) => s.key === "approve"), "auto preset: no approval step");
    } finally {
      hook.close();
    }
  });

  it("asks first under the manual preset and records a rejected start as cancelled", async () => {
    await policy.setApprovalMode("manual");
    const hook = await receiver(() => ({ status: 200, body: {} }));
    try {
      const t = await db.upsertTask({ platform: "custom", key: "deploy-job", name: "Deploy job", source: "push", delivery: { mode: "webhook", webhook_url: hook.url } });
      // Deliberately NOT awaited: the start parks on its approval, which the test rejects below.
      const pending = startTask(t.id);
      let approval;
      for (let i = 0; i < 100 && !approval; i++) {
        await new Promise((r) => setTimeout(r, 30));
        approval = (await policy.pendingApprovals()).find((a) => /Deploy job/.test(a.summary));
      }
      assert.ok(approval);
      await policy.decide(approval.id, "rejected");
      const run = await pending;
      assert.equal(run.status, "cancelled");
      assert.equal(hook.calls.length, 0, "nothing reached the agent");
    } finally {
      hook.close();
      await policy.setApprovalMode("auto");
    }
  });
});
