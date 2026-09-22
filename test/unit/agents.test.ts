import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { backfillAgents, ensureProviderAgent, ensureSystemAgent, ensureTaskAgent } = await import("../../src/agents.js");
const { beginRun, endRun } = await import("../../src/runs.js");

describe("agent profiles", () => {
  it("a provider's assistant is one profile, created on first use, with its verified capabilities", () => {
    const a = ensureProviderAgent("chatgpt")!;
    const again = ensureProviderAgent("chatgpt")!;
    assert.equal(a.id, again.id);
    assert.equal(a.kind, "assistant");
    assert.equal(a.provider_id, "chatgpt");
    assert.equal(a.name, "ChatGPT");
    const caps = JSON.parse(a.capabilities!) as string[];
    assert.ok(caps.includes("chat") && caps.includes("listTasks"));
    assert.ok(!caps.includes("createTask"), "unsupported operations are not claimed");
    assert.equal(ensureProviderAgent("custom"), null, "custom agents are their own profiles");
  });

  it("a task at a provider belongs to that provider's assistant; a custom task gets its own profile", () => {
    const t1 = db.upsertTask({ platform: "claude", key: "weekly-research", name: "Weekly research", source: "discovered" });
    const a1 = ensureTaskAgent(t1)!;
    assert.equal(a1.key, "claude");
    assert.equal(db.getTask(t1.id)!.agent_id, a1.id);
    const t2 = db.upsertTask({ platform: "custom", key: "repo-scan", name: "Repository scan", source: "push", purpose: "scans repos" });
    const a2 = ensureTaskAgent(t2)!;
    assert.equal(a2.key, "custom/repo-scan");
    assert.equal(a2.kind, "custom");
    assert.equal(a2.name, "Repository scan");
    assert.equal(db.getTask(t2.id)!.agent_id, a2.id);
  });

  it("a named profile in an ingest payload groups several tasks under one agent", () => {
    const t1 = db.upsertTask({ platform: "custom", key: "job-a", name: "Job A", source: "push" });
    const t2 = db.upsertTask({ platform: "custom", key: "job-b", name: "Job B", source: "push" });
    const a = ensureTaskAgent(t1, { key: "scanner-bot", name: "Scanner bot", description: "watches repos" })!;
    const b = ensureTaskAgent(t2, { key: "scanner-bot" })!;
    assert.equal(a.id, b.id);
    assert.equal(a.name, "Scanner bot");
    assert.equal(db.listTasks({ agent_id: a.id }).length, 2);
    assert.equal(db.getAgentProfile(a.id)!.task_count, 2);
  });

  it("runs carry their agent and the profile summary counts them", () => {
    const sys = ensureSystemAgent();
    const { run } = beginRun({ kind: "sync", label: "look", provider: "chatgpt", agent_id: sys.id });
    assert.equal(db.getAgentProfile(sys.id)!.running, 1);
    endRun(run.id, { status: "success" });
    const after = db.getAgentProfile(sys.id)!;
    assert.equal(after.running, 0);
    assert.ok(after.last_run_at);
    assert.ok(db.listRuns({ agent_id: sys.id }).some((r) => r.id === run.id && r.agent_name === "Control plane"));
  });

  it("backfill attaches tasks that have no agent yet and is idempotent", () => {
    const t = db.upsertTask({ platform: "grok", key: "x-monitor", name: "X monitor", source: "discovered" });
    assert.equal(t.agent_id, null);
    assert.ok(backfillAgents() >= 1);
    assert.equal(db.getTask(t.id)!.agent_id, ensureProviderAgent("grok")!.id);
    assert.equal(backfillAgents(), 0);
  });
});
