import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { briefing, speak } = await import("../../src/assistant.js");
const { classify } = await import("../../src/intents.js");
const { answerQuestion, handleControl } = await import("../../src/answers.js");
const { beginRun, endRun } = await import("../../src/runs.js");
const { ensureSystemAgent } = await import("../../src/agents.js");

describe("the control plane's own voice", () => {
  it("briefs on what is actually true, and on nothing else", () => {
    const agent = ensureSystemAgent();
    const { run } = beginRun({ kind: "sync", label: "Looking at Grok's tasks", provider: "grok", agent_id: agent.id });
    const { run: bad } = beginRun({ kind: "chat", label: "Message to Claude", provider: "claude", agent_id: agent.id });
    endRun(bad.id, { status: "failed", error: "the composer never appeared" });
    const b = briefing();
    assert.match(b, /Now: \d{4}-/);
    assert.match(b, /Running now:\n- run #\d+ Looking at Grok's tasks on grok/);
    assert.match(b, /Failed or needing attention today:[\s\S]*Message to Claude on claude: the composer never appeared/);
    assert.match(b, /Providers: .*Grok \(grok\)/);
    assert.ok(b.length < 8_100, "a briefing stays small enough to send with every reply");
    endRun(run.id, { status: "success", summary: "no change" });
    assert.match(briefing(), /Completed today:[\s\S]*Looking at Grok's tasks on grok: no change/);
    assert.match(briefing(), /Running now: nothing/);
  });

  it("says the control plane's own answer when no Claude credential is configured", async () => {
    // Unit tests run with ROUTER_PROVIDER=none: the deterministic sentence must survive untouched.
    const answer = answerQuestion({ kind: "question", topic: "running", provider: null, timeframe: "all", source: "rules" });
    const spoken = await speak({ text: "what is running?", intent: { kind: "question", topic: "running", provider: null, timeframe: "all", source: "rules" }, answer, conversationId: null });
    assert.equal(spoken.source, "control-plane");
    assert.equal(spoken.text, answer.text);
  });

  it("gives Claude the facts and the thread, and keeps the control plane's answer when Claude cannot help", async () => {
    const { config } = await import("../../src/config.js");
    const intent = { kind: "question", topic: "failed", provider: null, timeframe: "today", source: "rules" } as const;
    const answer = answerQuestion(intent);
    const conversation = db.createConversation("thread");
    db.updateMessage(db.createMessage("what is running?", conversation.id).id, { response: "Nothing is running right now." });
    db.createMessage("and what failed today?", conversation.id);

    const was = config.router.llm;
    config.router.llm = true; // as if CLAUDE_CODE_OAUTH_TOKEN were set
    try {
      let seen = "";
      const good = await speak({ text: "and what failed today?", intent, answer, conversationId: conversation.id }, async (_system: string, user: string) => {
        seen = user;
        return { result: { reply: "One run failed today: the message to Claude, because the composer never appeared." } };
      });
      assert.equal(good.source, "claude");
      assert.match(good.text, /^One run failed today/);
      assert.ok(seen.includes(answer.text), "Claude is given the answer the control plane already computed");
      assert.match(seen, /Briefing \(the only other facts you may use\):/);
      assert.match(seen, /Failed or needing attention today:/);
      assert.match(seen, /Earlier in this conversation:[\s\S]*Nothing is running right now\./, "and the thread so far");
      assert.match(seen, /The user's message:\nand what failed today\?$/);
      assert.ok(!seen.includes("and what failed today?\nControl plane"), "the message being answered is not replayed as history");

      const refused = await speak({ text: "x", intent, answer, conversationId: null }, async () => ({ result: null, error: "Claude declined" }));
      assert.deepEqual(refused, { text: answer.text, source: "control-plane" });
      const broken = await speak({ text: "x", intent, answer, conversationId: null }, async () => {
        throw new Error("network down");
      });
      assert.deepEqual(broken, { text: answer.text, source: "control-plane" }, "a model that fails never costs the user their answer");
      const empty = await speak({ text: "x", intent, answer, conversationId: null }, async () => ({ result: { reply: "   " } }));
      assert.equal(empty.source, "control-plane");
    } finally {
      config.router.llm = was;
    }
  });

  it("answers a greeting and a 'what can you do' itself, without troubling a provider", async () => {
    for (const hello of ["hi", "Hello!", "thanks", "ok", "good morning"]) {
      const i = classify(hello);
      assert.equal(i.kind, "assistant", `"${hello}" is said to the control plane`);
      if (i.kind === "assistant") assert.equal(i.topic, "greeting");
    }
    for (const ask of ["what can you do?", "who are you", "help"]) {
      const i = classify(ask);
      assert.equal(i.kind, "assistant", `"${ask}" is said to the control plane`);
      if (i.kind === "assistant") assert.equal(i.topic, "help");
    }
    // Still not ours: anything addressed to an AI, or a greeting carrying a real request.
    assert.equal(classify("hey claude, write me a poem").kind, "chat");
    assert.equal(classify("thanks, now summarise the news").kind, "chat");

    const conversation = db.createConversation("greeting");
    const m = db.createMessage("hi", conversation.id);
    const answer = await handleControl({ kind: "assistant", topic: "greeting", source: "rules" }, m.id);
    assert.match(answer.text, /^Hello\./);
    assert.match(answer.text, /agents · \d+ tasks/, "a greeting still carries the state, so it is worth reading");
    const saved = db.getMessage(m.id)!;
    assert.equal(saved.status, "done");
    assert.equal(saved.response, answer.text);
    assert.equal(saved.run_id, null, "talking to the control plane is not a run");

    const help = await handleControl({ kind: "assistant", topic: "help", source: "rules" }, db.createMessage("what can you do?", conversation.id).id);
    assert.match(help.text, /control plane/i);
    assert.match(help.text, /run, pause, resume, stop, approve or reject/);
  });
});
