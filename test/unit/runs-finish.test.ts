import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { beginRun, endRun } = await import("../../src/runs.js");

describe("run finish is single-shot", () => {
  it("the first outcome wins; a later finish cannot overwrite it", () => {
    const { run } = beginRun({ kind: "external", label: "double finish", provider: "custom" });
    const first = endRun(run.id, { status: "failed", error: "boom" });
    assert.equal(first?.status, "failed");
    // A late success report (e.g. an inbox ack after a restart marked the run failed) must not flip it.
    const second = endRun(run.id, { status: "success", summary: "late report" });
    assert.equal(second?.status, "failed");
    const row = db.getRun(run.id)!;
    assert.equal(row.status, "failed");
    assert.equal(row.error, "boom");
  });

  it("finishRun itself refuses to touch a settled run", () => {
    const { run } = beginRun({ kind: "external", label: "guarded", provider: "custom" });
    assert.equal(db.finishRun(run.id, { status: "success", summary: "done" })?.status, "success");
    const after = db.finishRun(run.id, { status: "failed", error: "late" });
    assert.equal(after?.status, "success");
    assert.equal(db.getRun(run.id)!.status, "success");
    assert.equal(db.getRun(run.id)!.summary, "done");
  });

  it("cancelling after completion changes nothing", () => {
    const { run } = beginRun({ kind: "chat", label: "settled", provider: "custom" });
    endRun(run.id, { status: "success", summary: "ok" });
    const late = endRun(run.id, { status: "cancelled", error: "stop" });
    assert.equal(late?.status, "success");
  });
});
