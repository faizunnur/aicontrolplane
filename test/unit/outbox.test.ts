import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { beginRun } = await import("../../src/runs.js");

describe("outbox event log", () => {
  it("every announced change lands in the log, in order, with a replay cursor", async () => {
    const before = await db.outboxAfter(0, 2000);
    const cursor = before.at(-1)?.id ?? 0;
    const t = await db.upsertTask({ platform: "chatgpt", key: "outbox-probe", name: "Outbox probe", source: "discovered" });
    const { run, track } = await beginRun({ kind: "sync", label: "probe", provider: "chatgpt", task_id: t.id });
    await track.start("open", "Opening");
    const after = await db.outboxAfter(cursor, 2000);
    const topics = after.map((e) => e.topic);
    assert.ok(topics.includes("task"), "the task upsert was logged");
    assert.ok(topics.includes("run"), "the run start was logged");
    assert.ok(topics.includes("run-event"), "the step was logged");
    const runEntry = after.find((e) => e.topic === "run")!;
    assert.equal(JSON.parse(runEntry.payload!).id, run.id, "payloads carry the row");
    assert.deepEqual(
      after.map((e) => e.id),
      [...after.map((e) => e.id)].sort((a, b) => a - b),
      "ids are the order",
    );
  });

  it("pruning trims old entries and leaves fresh ones", async () => {
    await db.upsertTask({ platform: "chatgpt", key: "outbox-probe-2", name: "Outbox probe 2", source: "discovered" });
    const removed = await db.pruneOutbox(0); // everything is "old" at a zero window
    assert.ok(removed > 0);
    await db.upsertTask({ platform: "chatgpt", key: "outbox-probe-3", name: "Outbox probe 3", source: "discovered" });
    assert.ok((await db.outboxAfter(0, 10)).length > 0, "new entries keep flowing");
  });
});

describe("idempotent run submission", () => {
  it("the same key returns the same run instead of a second execution", async () => {
    const { run } = await beginRun({ kind: "external", label: "idem", provider: "custom", idempotency_key: "probe:once" });
    const { run: again } = await beginRun({ kind: "external", label: "idem retry", provider: "custom", idempotency_key: "probe:once" });
    assert.equal(again.id, run.id);
    assert.equal((await db.listRuns({ kind: "external", limit: 100 })).filter((r) => r.idempotency_key === "probe:once").length, 1);
  });
});
