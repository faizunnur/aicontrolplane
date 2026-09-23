/**
 * End to end: the real server, headless Chromium, and a mock AI site standing in for a provider.
 * Covers chat delivery with the step trail, both approval modes, stopping a run, conversations,
 * the SSE stream and the live browser socket.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { MOCK_SELECTORS, startMockProvider, type MockProvider } from "../helpers/mock-provider.js";
import { listenSse, startServer, waitFor, type TestServer } from "../helpers/server.js";

const FINAL = new Set(["done", "failed", "cancelled"]);

describe("workspace end to end", { timeout: 600_000 }, () => {
  let mock: MockProvider;
  let s: TestServer;
  let sse: Awaited<ReturnType<typeof listenSse>>;
  let conversationId = 0;
  let firstMessageId = 0;

  const message = async (id: number) => (await s.api(`/conversations/${conversationId}`)).messages.find((m: any) => m.id === id);
  const untilFinal = (id: number) => waitFor(async () => { const m = await message(id); return FINAL.has(m?.status) ? m : null; }, 120_000);
  const untilStep = (id: number, key: string, status: string) => waitFor(async () => { const m = await message(id); return (m?.steps ?? []).some((st: any) => st.key === key && st.status === status) ? m : null; }, 90_000);

  before(async () => {
    mock = await startMockProvider();
    s = await startServer();
    sse = await listenSse(s);
    await s.api("/connections", { body: { name: "Mock AI", appUrl: mock.url, purpose: "testing the workspace" } });
    await s.api("/connections/mock-ai", { method: "PUT", body: { ...MOCK_SELECTORS, chatUrl: mock.url } });
    for (const id of ["chatgpt", "claude", "grok", "gemini"]) await s.api(`/connections/${id}`, { method: "DELETE" }).catch(() => null);
  });
  after(async () => {
    // Each step is best effort and independent: whatever happens, nothing here may keep the process alive.
    try {
      sse?.stop();
    } catch {
      /* already closed */
    }
    try {
      await s?.stop();
    } catch {
      /* already gone */
    }
    await mock?.close().catch(() => undefined);
  });

  it("connects the mock provider through the browser", async () => {
    const r = await s.api("/connections/mock-ai/check", { body: {} });
    assert.equal(r.status, "logged_in");
  });

  it("serves the home payload the workspace needs", async () => {
    const home = await s.api("/home");
    assert.ok(Array.isArray(home.conversations));
    assert.ok(["auto", "manual"].includes(home.approvalMode));
    assert.ok(Array.isArray(home.browser.pages) && "active" in home.browser);
  });

  it("auto mode: delivers a message and reads the reply back with a full step trail", async () => {
    await s.api("/settings/approval", { method: "PUT", body: { approvalMode: "auto" } });
    const r = await s.api("/chat", { body: { text: "Hello from the workspace test" } });
    assert.ok(r.conversation.title.startsWith("Hello from"));
    assert.equal(r.routed, "mock-ai");
    conversationId = r.conversation.id;
    firstMessageId = r.message.id;
    const m = await untilFinal(r.message.id);
    assert.equal(m.status, "done");
    assert.match(m.response, /You said: Hello from the workspace test/);
    const keys = m.steps.map((st: any) => `${st.key}:${st.status}`);
    for (const k of ["route:done", "open:done", "check:done", "type:done", "send:done", "wait:done", "read:done", "done:done"]) assert.ok(keys.includes(k), `missing ${k} in ${keys}`);
    assert.ok(!keys.some((k: string) => k.startsWith("approve")), "auto mode must not ask");
  });

  it("every execution is a run with a timeline, carried out by an agent", async () => {
    const m = await message(firstMessageId);
    assert.ok(m.run_id, "the message points at its run");
    const run = await s.api(`/runs/${m.run_id}`);
    assert.equal(run.kind, "chat");
    assert.equal(run.provider, "mock-ai");
    assert.equal(run.status, "success");
    assert.equal(run.message_id, firstMessageId);
    assert.ok(run.finished_at);
    assert.ok(run.events.length >= 8, `events: ${run.events.length}`);
    assert.deepEqual(run.steps.map((st: any) => st.key), m.steps.map((st: any) => st.key), "the message mirrors the run's step view");
    const agents = await s.api("/agents");
    const assistant = agents.find((a: any) => a.key === "mock-ai");
    assert.ok(assistant, "the provider's assistant profile exists after its first run");
    assert.equal(assistant.kind, "assistant");
    assert.equal(run.agent_id, assistant.id);
    const runs = await s.api("/runs?kind=chat");
    assert.ok(runs.some((r: any) => r.id === run.id && r.agent_name === "Mock AI"));
  });

  it("manual mode: pauses before sending, then sends after approval", async () => {
    await s.api("/settings/approval", { method: "PUT", body: { approvalMode: "manual" } });
    const r = await s.api("/chat", { body: { text: "Second message, please approve", conversation_id: conversationId } });
    assert.equal(r.conversation.id, conversationId);
    const waiting = await untilStep(r.message.id, "approve", "waiting");
    assert.ok(waiting, "should pause on the approve step");
    assert.ok(!waiting.steps.some((st: any) => st.key === "send"), "must not send before approval");
    const pend = await s.api("/settings/approval");
    assert.ok(pend.pending.some((p: any) => p.messageId === r.message.id));
    // Asking what needs approval is answered by the control plane, not typed into the provider, even while it waits.
    const q = await s.api("/chat", { body: { text: "What requires my approval?", conversation_id: conversationId } });
    assert.equal(q.routed, "control");
    assert.equal(q.message.status, "done");
    assert.equal(q.message.run_id, null);
    assert.match(q.message.response, /Send this to Mock AI\?/);
    // And approving in words works too.
    const yes = await s.api("/chat", { body: { text: "approve it", conversation_id: conversationId } });
    assert.equal(yes.routed, "control");
    assert.match(yes.message.response, /^Approved: Send this to Mock AI/);
    const m = await untilFinal(r.message.id);
    assert.equal(m.status, "done");
    assert.ok(m.steps.some((st: any) => st.key === "approve" && st.status === "done"));
    const running = await s.api("/chat", { body: { text: "What is running?", conversation_id: conversationId } });
    assert.equal(running.routed, "control");
    assert.match(running.message.response, /Nothing is running right now/);
    const failed = await s.api("/chat", { body: { text: "what failed today?", conversation_id: conversationId } });
    assert.equal(failed.routed, "control");
    assert.match(failed.message.response, /Nothing failed today/);
  });

  it("manual mode: a rejection leaves the message unsent", async () => {
    const r = await s.api("/chat", { body: { text: "Third message, reject this", conversation_id: conversationId } });
    await untilStep(r.message.id, "approve", "waiting");
    await s.api(`/chat/${r.message.id}/approve`, { body: { decision: "reject" } });
    const m = await untilFinal(r.message.id);
    assert.equal(m.status, "cancelled");
    assert.ok(!m.steps.some((st: any) => st.key === "send"));
  });

  it("stop while waiting for the answer cancels the run", async () => {
    await s.api("/settings/approval", { method: "PUT", body: { approvalMode: "auto" } });
    const r = await s.api("/chat", { body: { text: "Fourth message, will be stopped", conversation_id: conversationId } });
    await untilStep(r.message.id, "send", "done");
    await s.api(`/chat/${r.message.id}/cancel`, { body: {} });
    const m = await untilFinal(r.message.id);
    assert.equal(m.status, "cancelled");
  });

  it("conversation summaries carry counts, last status and rename", async () => {
    const list = await s.api("/conversations");
    const mine = list.find((c: any) => c.id === conversationId);
    assert.equal(mine.message_count, 8);
    assert.equal(mine.last_status, "cancelled");
    assert.equal(mine.active, 0);
    const renamed = await s.api(`/conversations/${conversationId}`, { method: "PATCH", body: { title: "Renamed thread" } });
    assert.equal(renamed.title, "Renamed thread");
  });

  it("detects a signed-out provider instead of typing into it", async () => {
    mock.setSignedIn(false);
    try {
      const r = await s.api("/chat", { body: { text: "This should not be sent", conversation_id: conversationId } });
      const m = await untilFinal(r.message.id);
      assert.equal(m.status, "failed");
      assert.match(m.error, /sign in/i);
      const conn = (await s.api("/connections")).find((c: any) => c.id === "mock-ai");
      assert.equal(conn.status, "needs_login");
    } finally {
      mock.setSignedIn(true);
      await s.api("/connections/mock-ai/check", { body: {} });
    }
  });

  it("recognises a sign-in page blocked by a bot check and offers the desktop mode", async () => {
    mock.setSignedIn(false);
    mock.setChallenge(true);
    try {
      const r = await s.api("/connections/mock-ai/connect", { body: {} });
      assert.equal(r.mode, "live");
      assert.equal(r.challenge, "cloudflare");
      assert.equal(r.blocked, true);
      assert.equal(r.preferred, "live", "an unknown provider starts in the live view");
      assert.equal(r.desktop.ok, false, "the test server runs headless: no desktop to sign in on");
      assert.match(r.desktop.reason, /without a display/);
      const desk = await s.raw("/api/connections/mock-ai/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "desktop" }) });
      assert.equal(desk.status, 409);
      const audit = await s.api("/audit?action=signin.blocked");
      assert.ok(audit.some((a: any) => a.target === "mock-ai"));
      const grok = (await s.api("/providers")).find((p: any) => p.id === "grok") ?? (await s.api("/providers/grok"));
      assert.ok(grok, "grok is still known even if hidden");
    } finally {
      mock.setChallenge(false);
      mock.setSignedIn(true);
      await s.api("/connections/mock-ai/check", { body: {} });
    }
  });

  it("keeps a server log you can read from the product, and tells a reloaded page how to reach a sign-in", async () => {
    const home = await s.api("/home");
    assert.equal(home.signInOptions.desktop.ok, false, "headless here; a page can still learn where the desktop view would be");
    assert.match(home.signInOptions.vnc.url, /^\/vnc\//);
    await s.api("/connections/mock-ai/check", { body: {} }); // a POST lands in the request log
    const logs = await s.api("/logs?limit=200");
    assert.ok(Array.isArray(logs.lines) && logs.lines.length > 0);
    assert.ok(logs.lines.some((l: any) => l.scope === "server" && /POST \/api\/connections\/mock-ai\/check → 200/.test(l.msg)), "requests that change something are logged with their outcome");
    assert.ok(logs.scopes.includes("server"));
    const warnOnly = await s.api("/logs?level=warn&limit=200");
    assert.ok(warnOnly.lines.every((l: any) => l.level === "warn" || l.level === "error"));
    const set = await s.api("/logs/level", { method: "PUT", body: { level: "debug" } });
    assert.equal(set.level, "debug");
    assert.equal((await s.api("/logs?limit=1")).level, "debug");
    const bad = await s.raw("/api/logs/level", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "loud" }) });
    assert.equal(bad.status, 400);
    await s.api("/logs/level", { method: "PUT", body: { level: "info" } });
    const audit = await s.api("/audit?action=log.level");
    assert.ok(audit.length >= 2, "changing what the console prints is audited");
  });

  it("custom agents register, report runs under a named profile, and appear beside the assistants", async () => {
    const token = (await s.api("/settings")).ingestToken;
    const ingest = (p: string, body: unknown) => fetch(`${s.base}/api${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
    const reg = await ingest("/agents/register", { key: "scanner-bot", name: "Scanner bot", description: "watches repositories", capabilities: ["scan"] });
    assert.equal(reg.status, 200);
    assert.equal(reg.data.agent.kind, "custom");
    const rep = await ingest("/ingest", { agent: { key: "repo-scan", platform: "custom", name: "Repository scan", schedule: "nightly" }, profile: { key: "scanner-bot" }, run: { status: "success", summary: "0 issues" } });
    assert.equal(rep.status, 200);
    assert.equal(rep.data.profile.key, "scanner-bot");
    assert.equal(rep.data.run.kind, "external");
    assert.equal(rep.data.run.agent_id, reg.data.agent.id);
    const detail = await s.api(`/agents/${reg.data.agent.id}`);
    assert.equal(detail.task_count, 1);
    assert.equal(detail.tasks[0].key, "repo-scan");
    assert.equal(detail.runs[0].summary, "0 issues");
    const tasks = await s.api("/tasks");
    assert.ok(tasks.some((t: any) => t.key === "repo-scan" && t.agent_id === reg.data.agent.id));
    const unauth = await fetch(`${s.base}/api/agents/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauth.status, 401);
  });

  it("the task registry answers for every provider, and agents stream a live run into it", async () => {
    const token = (await s.api("/settings")).ingestToken;
    const ingest = (p: string, body: unknown) => fetch(`${s.base}/api${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
    const tasks = await s.api("/tasks");
    const scan = tasks.find((t: any) => t.key === "repo-scan");
    assert.ok(scan, "the pushed task is in the registry");
    assert.equal(scan.provider.id, "custom");
    assert.equal(scan.agent.key, "scanner-bot");
    assert.equal(scan.result, "0 issues");
    assert.equal(scan.can.run, false, "no webhook, so it cannot be started from here");
    assert.match(scan.can.run_reason, /webhook/);
    const denied = await s.raw(`/api/tasks/${scan.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 409);

    // A live run: the agent opens it, streams its timeline, and finishes it.
    const opened = await ingest("/runs", { agent: { key: "repo-scan", platform: "custom" }, profile: { key: "scanner-bot" }, label: "Repository scan (live)" });
    assert.equal(opened.status, 200);
    assert.equal(opened.data.run.status, "running");
    const running = await s.api("/runs?status=running");
    assert.ok(running.some((r: any) => r.id === opened.data.run.id), "visible as running in the control plane");
    await ingest(`/runs/${opened.data.run.id}/events`, { key: "clone", label: "Cloning repositories", status: "done" });
    await ingest(`/runs/${opened.data.run.id}/events`, { key: "scan", label: "Scanning 12 repositories" });
    await ingest(`/runs/${opened.data.run.id}/events`, { type: "log", label: "found 2 outdated dependencies" });
    const mid = await s.api(`/runs/${opened.data.run.id}`);
    assert.deepEqual(mid.steps.map((st: any) => `${st.key}:${st.status}`), ["clone:done", "scan:running"]);
    const fin = await ingest(`/runs/${opened.data.run.id}/finish`, { status: "success", summary: "2 PRs opened", output_url: "https://example.com/prs" });
    assert.equal(fin.data.run.status, "success");
    const final = await s.api(`/runs/${opened.data.run.id}`);
    assert.equal(final.steps.find((st: any) => st.key === "scan").status, "done");
    assert.equal(final.output_url, "https://example.com/prs");
    const again = await ingest(`/runs/${opened.data.run.id}/finish`, { status: "failed" });
    assert.equal(again.status, 409, "a finished run stays finished");
    const detail = await s.api(`/tasks/${scan.id}`);
    assert.equal(detail.last_run.id, opened.data.run.id);
    assert.equal(detail.runs.length, 2);
  });

  it("the overview and activity feed answer from real rows", async () => {
    const o = await s.api("/overview");
    assert.equal(typeof o.counts.running, "number");
    assert.ok(o.counts.completed_today >= 2, `completed today: ${o.counts.completed_today}`);
    assert.ok(o.counts.failed_today >= 1, "the signed-out attempt failed today");
    assert.ok(o.counts.agents >= 2, "assistant + custom agent");
    assert.equal(o.counts.running, 0);
    assert.ok(o.recent.some((r: any) => r.kind === "chat" && r.provider_name === "Mock AI"));
    assert.ok(o.recent.every((r: any) => "current_step" in r && "elapsed_s" in r));
    assert.ok(Array.isArray(o.attention));
    const feed = await s.api("/activity?limit=50");
    assert.ok(feed.length >= 20);
    assert.ok(feed.some((e: any) => e.label === "Typing your message" && e.provider_name === "Mock AI"));
    assert.ok(feed.some((e: any) => e.type === "approval"));
    assert.ok(feed.every((e: any) => e.at && e.run_label !== undefined && e.run_status));
    const home = await s.api("/home");
    assert.ok(home.overview && home.overview.counts.tasks >= 1);
  });

  it("streams state changes over server-sent events", async () => {
    await new Promise((r) => setTimeout(r, 500));
    const kinds = new Set(sse.events.map((e) => e.ev));
    for (const k of ["msg", "conversation", "browser", "settings", "connection"]) assert.ok(kinds.has(k), `no ${k} event`);
    const updates = sse.events.filter((e) => e.ev === "msg" && e.data.id === firstMessageId).length;
    assert.ok(updates >= 8, `expected step-by-step updates, got ${updates}`);
    for (const k of ["run", "run-event", "approval", "agent", "task"]) assert.ok(kinds.has(k), `no ${k} event`);
  });

  it("live socket: sends state, meta and frames, accepts input and navigation", async () => {
    const result = await new Promise<{ frames: number; meta: any; state: boolean; bytes: number }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(s.base).port}/live`, { headers: { cookie: s.cookie } });
      let frames = 0, bytes = 0, state = false, meta: any = null;
      const timer = setTimeout(() => { ws.close(); resolve({ frames, meta, state, bytes }); }, 10_000);
      ws.on("open", () => ws.send(JSON.stringify({ t: "watch", platform: "mock-ai" })));
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          frames++;
          bytes += data.length;
          if (frames === 1) {
            ws.send(JSON.stringify({ t: "mouse", kind: "move", x: 0.5, y: 0.5 }));
            ws.send(JSON.stringify({ t: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 100 }));
            ws.send(JSON.stringify({ t: "nav", url: mock.url + "?nav=1" }));
          }
          if (frames >= 3 && meta?.url.includes("nav=1")) { clearTimeout(timer); ws.close(); resolve({ frames, meta, state, bytes }); }
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.t === "state") state = true;
        if (msg.t === "meta") meta = msg;
      });
      ws.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
    assert.ok(result.state, "state message");
    assert.ok(result.frames >= 3, `frames: ${result.frames}`);
    assert.ok(result.meta?.width > 0 && result.meta?.height > 0);
    assert.match(result.meta.url, /nav=1/);
  });

  it("live socket: refuses connections without the session cookie", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(s.base).port}/live`);
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("refused"));
      ws.on("unexpected-response", () => resolve("refused"));
    });
    assert.equal(outcome, "refused");
  });
});
