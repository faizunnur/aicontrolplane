import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { bus } = await import("../../src/bus.js");
const { beginRun, endRun, RunTracker, requestCancel, CancelledError } = await import("../../src/runs.js");

describe("schema", () => {
  it("applies every migration to a fresh database", async () => {
    const applied = (await db.schemaVersion()).map((m) => m.id);
    // SQLite replays its historical chain; Postgres starts from its own baseline (id 100+).
    if (db.dataDriver() === "sqlite") assert.deepEqual(applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    else assert.ok(applied.includes(100), "postgres baseline applied");
    if (db.db) {
      const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
      for (const t of ["tasks", "runs", "run_events", "agent_profiles", "messages", "conversations", "policies", "approvals", "audit_log", "sessions"]) assert.ok(tables.includes(t), `missing table ${t}`);
      assert.ok(!tables.includes("agents"), "the agents table is renamed to tasks");
    }
  });
});

describe("conversations and messages", () => {
  it("creates a conversation, adds messages, and summarises it", async () => {
    const c = await db.createConversation("Test thread");
    const m1 = await db.createMessage("first", c.id);
    await db.createMessage("second", c.id);
    await db.updateMessage(m1.id, { status: "delivered", platform: "chatgpt" });
    const sum = (await db.getConversation(c.id))!;
    assert.equal(sum.message_count, 2);
    assert.equal(sum.active, 1);
    assert.equal(sum.last_platform, "chatgpt");
    assert.equal((await db.conversationMessages(c.id)).map((m) => m.text).join(","), "first,second");
    assert.ok((await db.listConversations()).some((x) => x.id === c.id));
  });

  it("announces message changes on the bus", async () => {
    const seen: number[] = [];
    const h = (row: { id: number }) => seen.push(row.id);
    bus.on("message:row", h);
    const c = await db.createConversation();
    const m = await db.createMessage("hello", c.id);
    await db.updateMessage(m.id, { status: "done", response: "ok" });
    bus.off("message:row", h);
    assert.deepEqual(seen, [m.id, m.id]);
  });

  it("deleting a conversation removes its messages", async () => {
    const c = await db.createConversation("bye");
    const m = await db.createMessage("x", c.id);
    assert.ok(await db.deleteConversation(c.id));
    assert.equal(await db.getMessage(m.id), undefined);
  });
});

describe("tasks and reported runs", () => {
  it("upserts a task by (platform, key) and records runs with external ids once", async () => {
    const t = await db.upsertTask({ platform: "custom", key: "nightly", name: "Nightly", source: "push", schedule: "daily" });
    const again = await db.upsertTask({ platform: "custom", key: "nightly", purpose: "audit deps" });
    assert.equal(again.id, t.id);
    assert.equal(again.name, "Nightly");
    assert.equal(again.purpose, "audit deps");
    const r1 = await db.recordRun({ task_id: t.id, external_id: "e1", status: "success", source: "push", summary: "ok" });
    const r2 = await db.recordRun({ task_id: t.id, external_id: "e1", status: "failed", source: "push" });
    assert.equal(r1.created, true);
    assert.equal(r2.created, false);
    assert.equal(r2.run.id, r1.run.id);
    assert.equal(r2.run.status, "failed");
    assert.equal(r1.run.kind, "external");
    assert.equal(r1.run.provider, "custom");
    assert.equal(r1.run.label, "Nightly");
    assert.equal((await db.listTasks({ platform: "custom" }))[0].last_run?.status, "failed");
  });
});

describe("runs the control plane executes", () => {
  it("a message points at its run; the run's events fold into steps mirrored on the message", async () => {
    const c = await db.createConversation();
    const m = await db.createMessage("work", c.id);
    const { run, track } = await beginRun({ kind: "chat", label: "Message to Mock", provider: "mock", message_id: m.id });
    assert.equal(run.status, "running");
    assert.equal((await db.getMessage(m.id))!.run_id, run.id);
    await track.set("route", "Choosing", "done", "you chose it");
    await track.start("open", "Opening");
    await track.done("open", "example.com");
    await track.start("wait", "Waiting");
    await track.failRunning("gave up");
    const steps = await track.read();
    assert.deepEqual(steps.map((s) => `${s.key}:${s.status}`), ["route:done", "open:done", "wait:failed"]);
    assert.equal(steps[2].detail, "gave up");
    assert.ok(steps[1].ended_at);
    // While the run is live the row carries no snapshot; the timeline is the source of truth.
    assert.equal((await db.getMessage(m.id))!.steps, null);
    const events = await db.runEvents(run.id);
    assert.equal(events.filter((e) => e.type === "step").length, 5, "every state change is an event");
    const done = (await endRun(run.id, { status: "failed", error: "gave up" }))!;
    assert.equal(done.status, "failed");
    assert.ok(done.finished_at);
    assert.equal((await db.runEvents(run.id)).at(-1)!.type, "error");
    // Settling the run snapshots the folded steps onto the message row, once.
    assert.deepEqual(JSON.parse((await db.getMessage(m.id))!.steps!).map((s: { key: string }) => s.key), ["route", "open", "wait"]);
  });

  it("a run without a message keeps its timeline in run_events only", async () => {
    const { run, track } = await beginRun({ kind: "sync", label: "Looking at Mock", provider: "mock", trigger: "schedule" });
    await track.start("open", "Opening");
    await track.done("open");
    await track.log("captured 3 payloads");
    await endRun(run.id, { status: "success", summary: "3 tasks" });
    const r = (await db.getRun(run.id))!;
    assert.equal(r.status, "success");
    assert.equal(r.trigger, "schedule");
    assert.equal((await db.runEvents(run.id)).length, 4);
    assert.ok((await db.listRuns({ kind: "sync" })).some((x) => x.id === run.id));
  });

  it("stop requests surface as a CancelledError at the next step", async () => {
    const { run, track } = await beginRun({ kind: "action", label: "x", provider: "mock" });
    await requestCancel(run.id);
    await assert.rejects(async () => await track.start("a", "A"), CancelledError);
    await endRun(run.id, { status: "cancelled" });
    assert.equal((await db.getRun(run.id))!.status, "cancelled");
  });
});
