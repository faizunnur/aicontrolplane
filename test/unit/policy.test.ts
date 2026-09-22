import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const policy = await import("../../src/policy.js");
const { beginRun, endRun } = await import("../../src/runs.js");

describe("approval policy", () => {
  it("presets set everyday actions; dangerous actions always ask and cannot be relaxed", () => {
    policy.setApprovalMode("auto");
    assert.equal(policy.policyFor("send_message").mode, "auto");
    assert.equal(policy.policyFor("deploy_production").mode, "always");
    policy.setApprovalMode("manual");
    assert.equal(policy.policyFor("send_message").mode, "ask");
    assert.equal(policy.policyFor("run_action").mode, "ask");
    assert.equal(policy.policyFor("sync").mode, "auto", "reading a tasks page never needs approval");
    assert.equal(policy.policyFor("something-an-agent-made-up").mode, "ask", "unknown actions ask");
    assert.throws(() => policy.setPolicy("delete_resource", "auto"), /cannot be set below/);
    policy.setPolicy("send_message", "auto");
    assert.equal(policy.policyFor("send_message").mode, "auto");
    assert.equal(policy.policyFor("send_message").source, "override");
    policy.setPolicy("send_message", null);
    assert.equal(policy.policyFor("send_message").mode, "ask");
    policy.setApprovalMode("auto");
    assert.ok(policy.listPolicies().policies.some((p) => p.action === "deploy_production" && p.mode === "always"));
  });

  it("guard returns at once under auto and leaves an audit line", async () => {
    policy.setApprovalMode("auto");
    const { run, track } = beginRun({ kind: "chat", label: "x", provider: "mock" });
    const d = await policy.guard({ runId: run.id, provider: "mock", track }, "send_message", "Send this?");
    assert.equal(d, "approved");
    assert.ok(!track.read().some((s) => s.key === "approve"), "no approve step when nothing was asked");
    assert.ok(db.listAudit({ action: "send_message.auto" }).length >= 1);
    endRun(run.id, { status: "success" });
  });

  it("guard under ask persists an approval, shows it as a step, and follows the decision", async () => {
    policy.setApprovalMode("manual");
    const c = db.createConversation();
    const m = db.createMessage("hello", c.id);
    const { run, track } = beginRun({ kind: "chat", label: "x", provider: "mock", message_id: m.id });
    const pending = policy.guard({ runId: run.id, messageId: m.id, provider: "mock", track }, "send_message", "Send this?", "hello");
    await new Promise((r) => setTimeout(r, 20));
    const rows = policy.pendingApprovals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].message_id, m.id);
    assert.equal(track.read().find((s) => s.key === "approve")?.status, "waiting");
    assert.ok(db.runEvents(run.id).some((e) => e.type === "approval"));
    const decided = policy.decideForMessage(m.id, "approved");
    assert.equal(decided?.status, "approved");
    assert.equal(await pending, "approved");
    assert.equal(track.read().find((s) => s.key === "approve")?.status, "done");
    assert.equal(policy.pendingApprovals().length, 0);
    assert.equal(db.getApproval(rows[0].id)!.decided_by, "you");
    endRun(run.id, { status: "success" });

    const { run: run2, track: track2 } = beginRun({ kind: "chat", label: "y", provider: "mock" });
    const p2 = policy.guard({ runId: run2.id, provider: "mock", track: track2 }, "send_message", "Send that?");
    await new Promise((r) => setTimeout(r, 20));
    const row2 = policy.pendingApprovals()[0];
    policy.decide(row2.id, "rejected", "you", "not now");
    assert.equal(await p2, "rejected");
    assert.match(track2.read().find((s) => s.key === "approve")!.detail!, /not now/);
    endRun(run2.id, { status: "cancelled" });
    policy.setApprovalMode("auto");
  });

  it("guard times out into an expired approval", async () => {
    policy.setApprovalMode("manual");
    const { run, track } = beginRun({ kind: "chat", label: "z", provider: "mock" });
    const d = await policy.guard({ runId: run.id, provider: "mock", track }, "send_message", "Send?", null, { timeoutMs: 30 });
    assert.equal(d, "timeout");
    const row = db.listApprovals({ run_id: run.id })[0];
    assert.equal(row.status, "expired");
    endRun(run.id, { status: "cancelled" });
    policy.setApprovalMode("auto");
  });

  it("agents asking through the API get a pending row under ask and an instant yes under auto", () => {
    policy.setApprovalMode("auto");
    const yes = policy.requestExternalApproval({ action: "search", summary: "search the web" });
    assert.equal(yes.decision, "approved");
    const ask = policy.requestExternalApproval({ action: "deploy_production", summary: "deploy build 42" });
    assert.equal(ask.decision, "pending");
    assert.equal(db.getApproval(ask.approval.id)!.status, "pending");
    policy.decide(ask.approval.id, "approved");
    assert.equal(db.getApproval(ask.approval.id)!.status, "approved");
  });

  it("a restart marks pending approvals interrupted and surfaces their runs and messages", () => {
    policy.setApprovalMode("manual");
    const c = db.createConversation();
    const m = db.createMessage("deploy please", c.id);
    const { run } = beginRun({ kind: "chat", label: "interrupted", provider: "mock", message_id: m.id });
    db.updateMessage(m.id, { status: "delivered" });
    const a = db.createApproval({ run_id: run.id, message_id: m.id, action: "send_message", summary: "Send this?" });
    const n = policy.recoverInterruptedApprovals();
    assert.ok(n >= 1);
    assert.equal(db.getApproval(a.id)!.status, "interrupted");
    assert.equal(db.getRun(run.id)!.status, "needs_attention");
    assert.equal(db.getMessage(m.id)!.status, "failed");
    assert.match(db.getMessage(m.id)!.error!, /restarted/);
    assert.ok(db.listEvents({ limit: 5 }).some((e) => e.kind === "approval"));
    policy.setApprovalMode("auto");
  });
});
