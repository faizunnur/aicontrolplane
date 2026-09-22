import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapRunStatus, normalizePayloads, toIso } from "../../src/providers/browser/normalize.js";
import { DEFAULT_PLATFORMS } from "../../src/platforms.js";

describe("normalizer", () => {
  it("maps provider status words onto run statuses", () => {
    assert.equal(mapRunStatus("succeeded"), "success");
    assert.equal(mapRunStatus("ERRORED"), "failed");
    assert.equal(mapRunStatus("in_progress"), "running");
    assert.equal(mapRunStatus("action required"), "needs_attention");
    assert.equal(mapRunStatus(true), "success");
    assert.equal(mapRunStatus(""), "unknown");
  });

  it("reads seconds, milliseconds and ISO timestamps", () => {
    assert.equal(toIso(1_700_000_000), "2023-11-14T22:13:20.000Z");
    assert.equal(toIso(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
    assert.equal(toIso("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05.000Z");
    assert.equal(toIso("nope"), null);
  });

  it("picks tasks and their runs out of an unknown JSON shape", () => {
    const payload = {
      data: {
        automations: [
          { id: "t1", title: "Daily briefing", schedule: "every day 09:00", enabled: true, history: [{ id: "r1", status: "completed", finished_at: "2026-09-20T09:01:00Z", conversation_id: "c-abc" }] },
          { id: "t2", name: "Email monitor", cron: "0 * * * *", paused: true },
        ],
        runs: [{ id: "r2", task_id: "t2", state: "failed", started_at: 1_726_000_000, message: "selector not found" }],
      },
    };
    const { tasks, runs } = normalizePayloads(DEFAULT_PLATFORMS.chatgpt, [payload]);
    assert.deepEqual(tasks.map((t) => [t.key, t.name, t.status]), [["t1", "Daily briefing", "active"], ["t2", "Email monitor", "paused"]]);
    assert.equal(runs.length, 2);
    const r1 = runs.find((r) => r.external_id === "r1")!;
    assert.equal(r1.taskKey, "t1");
    assert.equal(r1.status, "success");
    // Provider-specific output links are the adapter's job (see providers.test.ts); the normaliser alone has no rule.
    assert.equal(r1.output_url, null);
    const hooked = normalizePayloads(DEFAULT_PLATFORMS.chatgpt, [payload], { outputUrlFor: (raw) => (typeof raw.conversation_id === "string" ? `https://chatgpt.com/c/${raw.conversation_id}` : null) });
    assert.equal(hooked.runs.find((r) => r.external_id === "r1")!.output_url, "https://chatgpt.com/c/c-abc");
    const r2 = runs.find((r) => r.external_id === "r2")!;
    assert.equal(r2.taskKey, "t2");
    assert.equal(r2.status, "failed");
    assert.equal(r2.summary, "selector not found");
  });
});
