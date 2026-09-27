import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { backfillAgents, ensureProviderAgent, ensureSystemAgent, ensureTaskAgent } = await import("../../src/agents.js");
const { beginRun, endRun } = await import("../../src/runs.js");

describe("agent profiles", () => {
  it("a provider's assistant is one profile, created on first use, with its verified capabilities", async () => {
    const a = (await ensureProviderAgent("chatgpt"))!;
    const again = (await ensureProviderAgent("chatgpt"))!;
    assert.equal(a.id, again.id);
    assert.equal(a.kind, "assistant");
    assert.equal(a.provider_id, "chatgpt");
    assert.equal(a.name, "ChatGPT");
    const caps = JSON.parse(a.capabilities!) as string[];
    assert.ok(caps.includes("chat") && caps.includes("listTasks"));
    assert.ok(!caps.includes("createTask"), "unsupported operations are not claimed");
    assert.equal(await ensureProviderAgent("custom"), null, "custom agents are their own profiles");
  });

  it("a task at a provider belongs to that provider's assistant; a custom task gets its own profile", async () => {
    const t1 = await db.upsertTask({ platform: "claude", key: "weekly-research", name: "Weekly research", source: "discovered" });
    const a1 = (await ensureTaskAgent(t1))!;
    assert.equal(a1.key, "claude");
    assert.equal((await db.getTask(t1.id))!.agent_id, a1.id);
    const t2 = await db.upsertTask({ platform: "custom", key: "repo-scan", name: "Repository scan", source: "push", purpose: "scans repos" });
    const a2 = (await ensureTaskAgent(t2))!;
    assert.equal(a2.key, "custom/repo-scan");
    assert.equal(a2.kind, "custom");
    assert.equal(a2.name, "Repository scan");
    assert.equal((await db.getTask(t2.id))!.agent_id, a2.id);
  });

  it("a named profile in an ingest payload groups several tasks under one agent", async () => {
    const t1 = await db.upsertTask({ platform: "custom", key: "job-a", name: "Job A", source: "push" });
    const t2 = await db.upsertTask({ platform: "custom", key: "job-b", name: "Job B", source: "push" });
    const a = (await ensureTaskAgent(t1, { key: "scanner-bot", name: "Scanner bot", description: "watches repos" }))!;
    const b = (await ensureTaskAgent(t2, { key: "scanner-bot" }))!;
    assert.equal(a.id, b.id);
    assert.equal(a.name, "Scanner bot");
    assert.equal((await db.listTasks({ agent_id: a.id })).length, 2);
    assert.equal((await db.getAgentProfile(a.id))!.task_count, 2);
  });

  it("runs carry their agent and the profile summary counts them", async () => {
    const sys = await ensureSystemAgent();
    const { run } = await beginRun({ kind: "sync", label: "look", provider: "chatgpt", agent_id: sys.id });
    assert.equal((await db.getAgentProfile(sys.id))!.running, 1);
    await endRun(run.id, { status: "success" });
    const after = (await db.getAgentProfile(sys.id))!;
    assert.equal(after.running, 0);
    assert.ok(after.last_run_at);
    assert.ok((await db.listRuns({ agent_id: sys.id })).some((r) => r.id === run.id && r.agent_name === "Control plane"));
  });

  it("backfill attaches tasks that have no agent yet and is idempotent", async () => {
    const t = await db.upsertTask({ platform: "grok", key: "x-monitor", name: "X monitor", source: "discovered" });
    assert.equal(t.agent_id, null);
    assert.ok(await backfillAgents() >= 1);
    assert.equal((await db.getTask(t.id))!.agent_id, (await ensureProviderAgent("grok"))!.id);
    assert.equal(await backfillAgents(), 0);
  });
});
