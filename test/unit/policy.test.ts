import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const policy = await import("../../src/policy.js");
const { beginRun, endRun } = await import("../../src/runs.js");

/** Poll until fn returns truthy or ~3s pass. */
async function eventually<T>(fn: () => Promise<T | null | undefined | false>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("condition never became true");
}

describe("approval policy", () => {
  it("presets set everyday actions; dangerous actions always ask and cannot be relaxed", async () => {
    await policy.setApprovalMode("auto");
    assert.equal((await policy.policyFor("send_message")).mode, "auto");
    assert.equal((await policy.policyFor("deploy_production")).mode, "always");
    // Reaching beyond a chat box asks even under the easy-going preset...
    assert.equal((await policy.policyFor("run_action")).mode, "ask");
    assert.equal((await policy.policyFor("dispatch_webhook")).mode, "ask");
    // ...though an explicit override may still relax either to auto (their floor).
    await policy.setPolicy("dispatch_webhook", "auto");
    assert.equal((await policy.policyFor("dispatch_webhook")).mode, "auto");
    await policy.setPolicy("dispatch_webhook", null);
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
    const d = await policy.guard({ runId: run.id, provider: "mock", track, kind: "test", checkpoint: { step: "send" } }, "send_message", "Send this?");
    assert.equal(d, "approved");
    assert.ok(!(await track.read()).some((s) => s.key === "approve"), "no approve step when nothing was asked");
    assert.ok((await db.listAudit({ action: "send_message.auto" })).length >= 1);
    await endRun(run.id, { status: "success" });
  });

  it("guard under ask parks the run durably; approval resumes it through the registered resumer", async () => {
    await policy.setApprovalMode("manual");
    const c = await db.createConversation();
    const m = await db.createMessage("hello", c.id);
    const { run, track } = await beginRun({ kind: "chat", label: "x", provider: "mock", message_id: m.id });
    const resumed: number[] = [];
    policy.registerResumer("park-test", async (r) => {
      resumed.push(r.id);
      await endRun(r.id, { status: "success", summary: "continued" });
    });
    await assert.rejects(
      () => policy.guard({ runId: run.id, messageId: m.id, provider: "mock", track, kind: "park-test", checkpoint: { step: "send", inputs: { a: 1 } } }, "send_message", "Send this?", "hello"),
      policy.ApprovalPending,
    );
    // Parked: nothing waits in memory; the run carries its checkpoint.
    const parked = (await db.getRun(run.id))!;
    assert.equal(parked.status, "waiting_approval");
    assert.equal(JSON.parse(parked.checkpoint!).inputs.a, 1);
    const rows = await policy.pendingApprovals();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message_id, m.id);
    assert.equal((await track.read()).find((s) => s.key === "approve")?.status, "waiting");
    assert.ok((await db.runEvents(run.id)).some((e) => e.type === "approval"));

    const decided = await policy.decideForMessage(m.id, "approved");
    assert.equal(decided?.status, "approved");
    await eventually(async () => (await db.getRun(run.id))!.status === "success");
    assert.deepEqual(resumed, [run.id], "the registered resumer continued the run");
    assert.equal((await new (await import("../../src/runs.js")).RunTracker(run.id).read()).find((s) => s.key === "approve")?.status, "done");
    assert.equal((await policy.pendingApprovals()).length, 0);
    assert.equal((await db.getApproval(rows[0].id))!.decided_by, "you");
  });

  it("a rejection settles the parked run as cancelled, with the reason on the step", async () => {
    await policy.setApprovalMode("manual");
    const c = await db.createConversation();
    const m = await db.createMessage("try me", c.id);
    const { run, track } = await beginRun({ kind: "chat", label: "y", provider: "mock", message_id: m.id });
    policy.registerResumer("reject-test", async () => {
      throw new Error("must never resume a rejected run");
    });
    await assert.rejects(() => policy.guard({ runId: run.id, messageId: m.id, provider: "mock", track, kind: "reject-test", checkpoint: { step: "send" } }, "send_message", "Send that?"), policy.ApprovalPending);
    const row = (await policy.pendingApprovals())[0];
    await policy.decide(row.id, "rejected", "you", "not now");
    const settled = await eventually(async () => {
      const r = (await db.getRun(run.id))!;
      return r.status === "cancelled" ? r : null;
    });
    assert.equal(settled.status, "cancelled");
    const steps = JSON.parse((await db.getMessage(m.id))!.steps!) as { key: string; status: string; detail?: string }[];
    assert.match(steps.find((s) => s.key === "approve")!.detail!, /not now/);
    assert.equal((await db.getMessage(m.id))!.status, "cancelled");
    await policy.setApprovalMode("auto");
  });

  it("the sweep expires overdue approvals and times their runs out", async () => {
    await policy.setApprovalMode("manual");
    const { run, track } = await beginRun({ kind: "chat", label: "z", provider: "mock" });
    await assert.rejects(() => policy.guard({ runId: run.id, provider: "mock", track, kind: "sweep-test", checkpoint: { step: "send" } }, "send_message", "Send?"), policy.ApprovalPending);
    assert.equal(await policy.sweepApprovals(60_000), 0, "not overdue yet");
    const expired = await policy.sweepApprovals(0);
    assert.equal(expired, 1);
    const row = (await db.listApprovals({ run_id: run.id }))[0];
    assert.equal(row.status, "expired");
    await eventually(async () => (await db.getRun(run.id))!.status === "timed_out");
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

  it("a restart keeps parked approvals waiting and closes only orphaned ones", async () => {
    await policy.setApprovalMode("manual");
    const c = await db.createConversation();
    const m = await db.createMessage("deploy please", c.id);
    // A healthy parked run: guard parked it before the "restart".
    const { run, track } = await beginRun({ kind: "chat", label: "survives", provider: "mock", message_id: m.id });
    await assert.rejects(() => policy.guard({ runId: run.id, messageId: m.id, provider: "mock", track, kind: "restart-test", checkpoint: { step: "send" } }, "send_message", "Send this?"), policy.ApprovalPending);
    const healthy = (await policy.pendingApprovals()).find((a) => a.run_id === run.id)!;
    // An orphan: its run died with the process (still "running" and about to be failed by run recovery).
    const { run: dead } = await beginRun({ kind: "chat", label: "orphan", provider: "mock" });
    const orphan = await db.createApproval({ run_id: dead.id, action: "send_message", summary: "Send that?" });
    await endRun(dead.id, { status: "failed", error: "process died" });

    await policy.recoverInterruptedApprovals();
    assert.equal((await db.getApproval(healthy.id))!.status, "pending", "a parked approval survives the restart");
    assert.equal((await db.getRun(run.id))!.status, "waiting_approval");
    assert.equal((await db.getApproval(orphan.id))!.status, "interrupted", "an approval whose run is gone is closed");
    // Clean up: reject the survivor.
    policy.registerResumer("restart-test", async () => undefined);
    await policy.decide(healthy.id, "rejected");
    await eventually(async () => (await db.getRun(run.id))!.status === "cancelled");
    await policy.setApprovalMode("auto");
  });
});
