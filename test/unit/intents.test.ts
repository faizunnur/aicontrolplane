import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { classify, resolveTarget } = await import("../../src/intents.js");
const { answerQuestion, executeCommand, handleControl } = await import("../../src/answers.js");
const { beginRun, endRun } = await import("../../src/runs.js");
const policy = await import("../../src/policy.js");
const { ensureProviderAgent, ensureTaskAgent } = await import("../../src/agents.js");

describe("intent classification", () => {
  const cases: [string, string][] = [
    ["What are all my agents doing?", "question:agents"],
    ["Show me all running tasks.", "question:running"],
    ["what is running?", "question:running"],
    ["What failed today?", "question:failed"],
    ["Anything failed this week?", "question:failed"],
    ["What requires my approval?", "question:approvals"],
    ["what needs my attention", "question:attention"],
    ["What did Claude complete?", "question:completed"],
    ["Summarize everything my agents did today.", "question:summary"],
    ["What's scheduled for tomorrow?", "question:scheduled"],
    ["how are things?", "question:status"],
    ["Continue the Claude research task.", "command:continue"],
    ["Pause the Grok monitoring task.", "command:pause"],
    ["Run the security scan again.", "command:run"],
    ["resume the nightly audit", "command:resume"],
    ["stop everything", "command:stop"],
    ["approve #12", "command:approve"],
    ["reject it", "command:reject"],
    ["Grok, what's trending in AI today?", "chat"],
    ["ask Claude to summarize this article", "chat"],
    ["@chatgpt write a haiku about running", "chat"],
    ["What's trending in AI today?", "chat"],
    ["Draft this week's status report", "chat"],
    ["run a marathon training plan for me", "chat"],
    ["how do I stop procrastinating?", "chat"],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" → ${expected}`, () => {
      const i = classify(text);
      const got = i.kind === "question" ? `question:${i.topic}` : i.kind === "command" ? `command:${i.action}` : "chat";
      assert.equal(got, expected);
    });
  }

  it("reads the provider and timeframe out of a question", () => {
    const i = classify("what did claude complete this week?");
    assert.equal(i.kind, "question");
    if (i.kind === "question") {
      assert.equal(i.provider, "claude");
      assert.equal(i.timeframe, "week");
    }
  });
});

describe("naming a task", () => {
  it("finds a task by its words, narrowed by a provider name", () => {
    db.upsertTask({ platform: "grok", key: "x-monitor", name: "X monitoring", source: "discovered" });
    db.upsertTask({ platform: "custom", key: "security-scan", name: "Security scan", source: "push", purpose: "scan repositories for vulnerabilities" });
    db.upsertTask({ platform: "claude", key: "weekly-research", name: "Weekly research", source: "discovered" });
    assert.equal(resolveTarget("grok monitoring task").task?.key, "x-monitor");
    assert.equal(resolveTarget("security scan").task?.key, "security-scan");
    assert.equal(resolveTarget("the claude research task").task?.key, "weekly-research");
    assert.equal(resolveTarget("vulnerability scan").task?.key, "security-scan", "purpose words count too");
    assert.equal(resolveTarget("something nobody has").matched, false);
  });
});

describe("answers come from the control plane's state", () => {
  it("running, failed, completed, approvals and attention reflect the runs and approvals", async () => {
    policy.setApprovalMode("auto");
    const sys = ensureProviderAgent("claude")!;
    const { run: r1, track } = beginRun({ kind: "chat", label: "Message to Claude", provider: "claude", agent_id: sys.id });
    track.start("wait", "Waiting for Claude to answer");
    const { run: r2 } = beginRun({ kind: "sync", label: "Looking at Grok's tasks", provider: "grok" });
    endRun(r2.id, { status: "failed", error: "selector not found" });
    const { run: r3 } = beginRun({ kind: "external", label: "Repository scan", provider: "custom" });
    endRun(r3.id, { status: "success", summary: "2 PRs opened" });

    const running = answerQuestion({ kind: "question", topic: "running", provider: null, timeframe: "all", source: "rules" });
    assert.match(running.text, /Message to Claude on Claude/);
    assert.match(running.text, /Waiting for Claude to answer/);
    const failed = answerQuestion({ kind: "question", topic: "failed", provider: null, timeframe: "today", source: "rules" });
    assert.match(failed.text, /Looking at Grok's tasks on Grok: selector not found/);
    const failedClaude = answerQuestion({ kind: "question", topic: "failed", provider: "claude", timeframe: "today", source: "rules" });
    assert.match(failedClaude.text, /Nothing failed today on Claude/);
    const completed = answerQuestion({ kind: "question", topic: "completed", provider: null, timeframe: "today", source: "rules" });
    assert.match(completed.text, /Repository scan .*2 PRs opened/);
    const agents = answerQuestion({ kind: "question", topic: "agents", provider: null, timeframe: "all", source: "rules" });
    assert.match(agents.text, /Claude: Message to Claude/);
    endRun(r1.id, { status: "success" });

    const a = db.createApproval({ run_id: null, message_id: null, action: "deploy_production", summary: "Deploy build 42" });
    const approvals = answerQuestion({ kind: "question", topic: "approvals", provider: null, timeframe: "all", source: "rules" });
    assert.match(approvals.text, new RegExp(`#${a.id} Deploy build 42`));
    const attention = answerQuestion({ kind: "question", topic: "attention", provider: null, timeframe: "all", source: "rules" });
    assert.match(attention.text, /Approval #\d+: Deploy build 42/);
    assert.match(attention.text, /Looking at Grok's tasks on Grok failed/);
    const done = await executeCommand({ kind: "command", action: "approve", target: `#${a.id}`, provider: null, source: "rules" }, { messageId: 0 });
    assert.match(done.text, /^Approved: Deploy build 42/);
    assert.equal(db.getApproval(a.id)!.status, "approved");
    const summary = answerQuestion({ kind: "question", topic: "summary", provider: null, timeframe: "today", source: "rules" });
    assert.match(summary.text, /Today: \d+ runs · \d+ completed · \d+ failed/);
  });

  it("commands act on tasks and say honestly what a provider cannot do", async () => {
    const t = db.upsertTask({ platform: "grok", key: "x-monitor", name: "X monitoring", source: "discovered" });
    ensureTaskAgent(t);
    const paused = await executeCommand({ kind: "command", action: "pause", target: "grok monitoring task", provider: "grok", source: "rules" }, { messageId: 0 });
    assert.match(paused.text, /Paused X monitoring here/);
    assert.match(paused.text, /grok.com/, "tells the user where the provider itself must be paused");
    assert.equal(db.getTask(t.id)!.enabled, 0);
    const resumed = await executeCommand({ kind: "command", action: "resume", target: "x monitoring", provider: null, source: "rules" }, { messageId: 0 });
    assert.match(resumed.text, /Resumed X monitoring/);
    const run = await executeCommand({ kind: "command", action: "run", target: "x monitoring", provider: null, source: "rules" }, { messageId: 0 });
    assert.match(run.text, /cannot be started from here/);
    assert.match(run.text, /Grok automations cannot be started on demand/);
    const missing = await executeCommand({ kind: "command", action: "run", target: "the moon landing", provider: null, source: "rules" }, { messageId: 0 });
    assert.match(missing.text, /could not find a task called "the moon landing"/);
  });

  it("a control message ends done with the answer, never with a provider", async () => {
    const c = db.createConversation();
    const m = db.createMessage("what is running?", c.id);
    const a = await handleControl({ kind: "question", topic: "running", provider: null, timeframe: "all", source: "rules" }, m.id);
    const after = db.getMessage(m.id)!;
    assert.equal(after.status, "done");
    assert.equal(after.response, a.text);
    assert.equal(after.platform, null);
    assert.equal(after.run_id, null);
    assert.equal(JSON.parse(after.routing!).method, "control");
  });
});
