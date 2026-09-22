import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { bus } = await import("../../src/bus.js");
const { beginRun, endRun, RunTracker, requestCancel, CancelledError } = await import("../../src/runs.js");

describe("schema", () => {
  it("applies every migration to a fresh database", () => {
    const applied = db.schemaVersion().map((m) => m.id);
    assert.deepEqual(applied, [1, 2, 3, 4, 5]);
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["tasks", "runs", "run_events", "agent_profiles", "messages", "conversations", "policies", "approvals", "audit_log", "sessions"]) assert.ok(tables.includes(t), `missing table ${t}`);
    assert.ok(!tables.includes("agents"), "the agents table is renamed to tasks");
  });
});

describe("conversations and messages", () => {
  it("creates a conversation, adds messages, and summarises it", () => {
    const c = db.createConversation("Test thread");
    const m1 = db.createMessage("first", c.id);
    db.createMessage("second", c.id);
    db.updateMessage(m1.id, { status: "delivered", platform: "chatgpt" });
    const sum = db.getConversation(c.id)!;
    assert.equal(sum.message_count, 2);
    assert.equal(sum.active, 1);
    assert.equal(sum.last_platform, "chatgpt");
    assert.equal(db.conversationMessages(c.id).map((m) => m.text).join(","), "first,second");
    assert.ok(db.listConversations().some((x) => x.id === c.id));
  });

  it("announces message changes on the bus", () => {
    const seen: number[] = [];
    const h = (row: { id: number }) => seen.push(row.id);
    bus.on("message:row", h);
    const c = db.createConversation();
    const m = db.createMessage("hello", c.id);
    db.updateMessage(m.id, { status: "done", response: "ok" });
    bus.off("message:row", h);
    assert.deepEqual(seen, [m.id, m.id]);
  });

  it("deleting a conversation removes its messages", () => {
    const c = db.createConversation("bye");
    const m = db.createMessage("x", c.id);
    assert.ok(db.deleteConversation(c.id));
    assert.equal(db.getMessage(m.id), undefined);
  });
});

describe("tasks and reported runs", () => {
  it("upserts a task by (platform, key) and records runs with external ids once", () => {
    const t = db.upsertTask({ platform: "custom", key: "nightly", name: "Nightly", source: "push", schedule: "daily" });
    const again = db.upsertTask({ platform: "custom", key: "nightly", purpose: "audit deps" });
    assert.equal(again.id, t.id);
    assert.equal(again.name, "Nightly");
    assert.equal(again.purpose, "audit deps");
    const r1 = db.recordRun({ task_id: t.id, external_id: "e1", status: "success", source: "push", summary: "ok" });
    const r2 = db.recordRun({ task_id: t.id, external_id: "e1", status: "failed", source: "push" });
    assert.equal(r1.created, true);
    assert.equal(r2.created, false);
    assert.equal(r2.run.id, r1.run.id);
    assert.equal(r2.run.status, "failed");
    assert.equal(r1.run.kind, "external");
    assert.equal(r1.run.provider, "custom");
    assert.equal(r1.run.label, "Nightly");
    assert.equal(db.listTasks({ platform: "custom" })[0].last_run?.status, "failed");
  });
});

describe("runs the control plane executes", () => {
  it("a message points at its run; the run's events fold into steps mirrored on the message", () => {
    const c = db.createConversation();
    const m = db.createMessage("work", c.id);
    const { run, track } = beginRun({ kind: "chat", label: "Message to Mock", provider: "mock", message_id: m.id });
    assert.equal(run.status, "running");
    assert.equal(db.getMessage(m.id)!.run_id, run.id);
    track.set("route", "Choosing", "done", "you chose it");
    track.start("open", "Opening");
    track.done("open", "example.com");
    track.start("wait", "Waiting");
    track.failRunning("gave up");
    const steps = track.read();
    assert.deepEqual(steps.map((s) => `${s.key}:${s.status}`), ["route:done", "open:done", "wait:failed"]);
    assert.equal(steps[2].detail, "gave up");
    assert.ok(steps[1].ended_at);
    assert.deepEqual(JSON.parse(db.getMessage(m.id)!.steps!).map((s: { key: string }) => s.key), ["route", "open", "wait"]);
    const events = db.runEvents(run.id);
    assert.equal(events.filter((e) => e.type === "step").length, 5, "every state change is an event");
    const done = endRun(run.id, { status: "failed", error: "gave up" })!;
    assert.equal(done.status, "failed");
    assert.ok(done.finished_at);
    assert.equal(db.runEvents(run.id).at(-1)!.type, "error");
  });

  it("a run without a message keeps its timeline in run_events only", () => {
    const { run, track } = beginRun({ kind: "sync", label: "Looking at Mock", provider: "mock", trigger: "schedule" });
    track.start("open", "Opening");
    track.done("open");
    track.log("captured 3 payloads");
    endRun(run.id, { status: "success", summary: "3 tasks" });
    const r = db.getRun(run.id)!;
    assert.equal(r.status, "success");
    assert.equal(r.trigger, "schedule");
    assert.equal(db.runEvents(run.id).length, 4);
    assert.ok(db.listRuns({ kind: "sync" }).some((x) => x.id === run.id));
  });

  it("stop requests surface as a CancelledError at the next step", () => {
    const { run, track } = beginRun({ kind: "action", label: "x", provider: "mock" });
    requestCancel(run.id);
    assert.throws(() => track.start("a", "A"), CancelledError);
    endRun(run.id, { status: "cancelled" });
    assert.equal(db.getRun(run.id)!.status, "cancelled");
  });
});
