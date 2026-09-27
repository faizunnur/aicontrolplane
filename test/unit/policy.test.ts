import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const policy = await import("../../src/policy.js");
const { beginRun, endRun } = await import("../../src/runs.js");

describe("approval policy", () => {
  it("presets set everyday actions; dangerous actions always ask and cannot be relaxed", async () => {
    await policy.setApprovalMode("auto");
    assert.equal((await policy.policyFor("send_message")).mode, "auto");
    assert.equal((await policy.policyFor("deploy_production")).mode, "always");
    await policy.setApprovalMode("manual");
    assert.equal((await policy.policyFor("send_message")).mode, "ask");
    assert.equal((await policy.policyFor("run_action")).mode, "ask");
    assert.equal((await policy.policyFor("sync")).mode, "auto", "reading a tasks page never needs approval");
    assert.equal((await policy.policyFor("something-an-agent-made-up")).mode, "ask", "unknown actions ask");
    await assert.rejects(async () => await policy.setPolicy("delete_resource", "auto"), /cannot be set below/);
    await policy.setPolicy("send_message", "auto");
    assert.equal((await policy.policyFor("send_message")).mode, "auto");
    assert.equal((await policy.policyFor("send_message")).source, "override");
    await policy.setPolicy("send_message", null);
    assert.equal((await policy.policyFor("send_message")).mode, "ask");
    await policy.setApprovalMode("auto");
    assert.ok((await policy.listPolicies()).policies.some((p) => p.action === "deploy_production" && p.mode === "always"));
  });

  it("guard returns at once under auto and leaves an audit line", async () => {
    await policy.setApprovalMode("auto");
    const { run, track } = await beginRun({ kind: "chat", label: "x", provider: "mock" });
    const d = await policy.guard({ runId: run.id, provider: "mock", track }, "send_message", "Send this?");
    assert.equal(d, "approved");
    assert.ok(!(await track.read()).some((s) => s.key === "approve"), "no approve step when nothing was asked");
    assert.ok((await db.listAudit({ action: "send_message.auto" })).length >= 1);
    await endRun(run.id, { status: "success" });
  });

  it("guard under ask persists an approval, shows it as a step, and follows the decision", async () => {
    await policy.setApprovalMode("manual");
    const c = await db.createConversation();
    const m = await db.createMessage("hello", c.id);
    const { run, track } = await beginRun({ kind: "chat", label: "x", provider: "mock", message_id: m.id });
    // Deliberately NOT awaited: the test decides the approval while guard is parked on it.
    const pending = policy.guard({ runId: run.id, messageId: m.id, provider: "mock", track }, "send_message", "Send this?", "hello");
    await new Promise((r) => setTimeout(r, 20));
    const rows = await policy.pendingApprovals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].message_id, m.id);
    assert.equal((await track.read()).find((s) => s.key === "approve")?.status, "waiting");
    assert.ok((await db.runEvents(run.id)).some((e) => e.type === "approval"));
    const decided = await policy.decideForMessage(m.id, "approved");
    assert.equal(decided?.status, "approved");
    assert.equal(await pending, "approved");
    assert.equal((await track.read()).find((s) => s.key === "approve")?.status, "done");
    assert.equal((await policy.pendingApprovals()).length, 0);
    assert.equal((await db.getApproval(rows[0].id))!.decided_by, "you");
    await endRun(run.id, { status: "success" });

    const { run: run2, track: track2 } = await beginRun({ kind: "chat", label: "y", provider: "mock" });
    // Deliberately NOT awaited: rejected while parked.
    const p2 = policy.guard({ runId: run2.id, provider: "mock", track: track2 }, "send_message", "Send that?");
    await new Promise((r) => setTimeout(r, 20));
    const row2 = (await policy.pendingApprovals())[0];
    await policy.decide(row2.id, "rejected", "you", "not now");
    assert.equal(await p2, "rejected");
    assert.match((await track2.read()).find((s) => s.key === "approve")!.detail!, /not now/);
    await endRun(run2.id, { status: "cancelled" });
    await policy.setApprovalMode("auto");
  });

  it("guard times out into an expired approval", async () => {
    await policy.setApprovalMode("manual");
    const { run, track } = await beginRun({ kind: "chat", label: "z", provider: "mock" });
    const d = await policy.guard({ runId: run.id, provider: "mock", track }, "send_message", "Send?", null, { timeoutMs: 30 });
    assert.equal(d, "timeout");
    const row = (await db.listApprovals({ run_id: run.id }))[0];
    assert.equal(row.status, "expired");
    await endRun(run.id, { status: "cancelled" });
    await policy.setApprovalMode("auto");
  });

  it("agents asking through the API get a pending row under ask and an instant yes under auto", async () => {
    await policy.setApprovalMode("auto");
    const yes = await policy.requestExternalApproval({ action: "search", summary: "search the web" });
    assert.equal(yes.decision, "approved");
    const ask = await policy.requestExternalApproval({ action: "deploy_production", summary: "deploy build 42" });
    assert.equal(ask.decision, "pending");
    assert.equal((await db.getApproval(ask.approval.id))!.status, "pending");
    await policy.decide(ask.approval.id, "approved");
    assert.equal((await db.getApproval(ask.approval.id))!.status, "approved");
  });

  it("a restart marks pending approvals interrupted and surfaces their runs and messages", async () => {
    await policy.setApprovalMode("manual");
    const c = await db.createConversation();
    const m = await db.createMessage("deploy please", c.id);
    const { run } = await beginRun({ kind: "chat", label: "interrupted", provider: "mock", message_id: m.id });
    await db.updateMessage(m.id, { status: "delivered" });
    const a = await db.createApproval({ run_id: run.id, message_id: m.id, action: "send_message", summary: "Send this?" });
    const n = await policy.recoverInterruptedApprovals();
    assert.ok(n >= 1);
    assert.equal((await db.getApproval(a.id))!.status, "interrupted");
    assert.equal((await db.getRun(run.id))!.status, "needs_attention");
    assert.equal((await db.getMessage(m.id))!.status, "failed");
    assert.match((await db.getMessage(m.id))!.error!, /restarted/);
    assert.ok((await db.listEvents({ limit: 5 })).some((e) => e.kind === "approval"));
    await policy.setApprovalMode("auto");
  });
});
