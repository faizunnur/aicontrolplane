/**
 * The gateway, end to end: a stand-in for the desktop app connects with a device token, and
 * from then on the workspace's browser work reaches it as jobs while its answers, steps and
 * state flow back into the control plane. The server holds no browser at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { startServer, waitFor } from "../helpers/server.js";

type Frame = Record<string, any>;

/** A minimal connector: one socket, a hello, and a way to wait for frames and answer them. */
async function connectFake(base: string, token: string) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/gw`, { headers: { authorization: `Bearer ${token}` } });
  const frames: Frame[] = [];
  const waiters = new Set<(f: Frame) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const f = JSON.parse(data.toString()) as Frame;
    frames.push(f);
    for (const w of [...waiters]) w(f);
  });
  ws.send(JSON.stringify({ t: "hello", protocol: 1, app: "fake-connector", version: "0.0.1", os: "test-os", chrome: "Chrome 153", providers: ["chatgpt"] }));
  const next = (pred: (f: Frame) => boolean, ms = 20_000) =>
    new Promise<Frame>((resolve, reject) => {
      const found = frames.find(pred);
      if (found) return resolve(found);
      const timer = setTimeout(() => {
        waiters.delete(w);
        reject(new Error(`no matching frame in ${ms}ms; saw ${frames.map((f) => f.t).join(",")}`));
      }, ms);
      const w = (f: Frame) => {
        if (!pred(f)) return;
        clearTimeout(timer);
        waiters.delete(w);
        resolve(f);
      };
      waiters.add(w);
    });
  return { ws, frames, next, send: (f: Frame) => ws.send(JSON.stringify(f)), close: () => ws.close() };
}

describe("gateway: a desktop connector is the workspace's browser", { timeout: 180_000 }, () => {
  it("pairs, answers jobs, reports steps and state, and is cut off when revoked", async () => {
    const server = await startServer({ BROWSER_ENABLED: "false" });
    try {
      const created = await server.api("/devices", { body: { name: "Test laptop" } });
      assert.match(created.token, /^acp_dev_[0-9a-f]{48}$/);
      assert.equal(created.device.name, "Test laptop");

      // The wrong token never gets a socket.
      await assert.rejects(connectFake(server.base, "acp_dev_" + "0".repeat(48)), /HTTP 401/);

      const fake = await connectFake(server.base, created.token);
      const welcome = await fake.next((f) => f.t === "welcome");
      assert.equal(welcome.deviceId, created.device.id);
      assert.ok(welcome.platforms.some((p: Frame) => p.id === "chatgpt"), "the welcome carries the workspace's provider configs");
      const listed = (await server.api("/devices")).devices.find((d: Frame) => d.id === created.device.id);
      assert.equal(listed.online, true);
      assert.equal(listed.app_version, "0.0.1");

      // An interactive browser op from the API is a job on the connector, and its answer is the API's answer.
      const checking = server.api("/connections/chatgpt/check", { body: {} });
      const job = await fake.next((f) => f.t === "job" && f.op === "auth.check");
      assert.equal(job.payload.platformId, "chatgpt");
      fake.send({ t: "result", jobId: job.jobId, ok: true, value: "logged_in" });
      assert.equal((await checking).status, "logged_in");

      // The connector's word on its sessions is the workspace's word.
      fake.send({ t: "platform", platformId: "chatgpt", patch: { session_status: "logged_in", last_error: null } });
      const card = await waitFor(async () => (await server.api("/connections")).find((c: Frame) => c.id === "chatgpt" && c.status === "logged_in"), 10_000);
      assert.ok(card, "the connection card shows the session the connector reported");

      // A chat message is delivered through the connector; its steps land on the run; the reply settles the message.
      const chat = await server.api("/chat", { body: { text: "Write a haiku about laptops", platform: "chatgpt" } });
      const send = await fake.next((f) => f.t === "job" && f.op === "chat.send", 30_000);
      assert.equal(send.payload.platformId, "chatgpt");
      assert.equal(send.payload.text, "Write a haiku about laptops");
      assert.ok(send.payload.runId, "the job names the run its steps belong to");
      fake.send({ t: "run-event", runId: send.payload.runId, key: "type", label: "Typing the message", status: "running" });
      fake.send({ t: "run-event", runId: send.payload.runId, key: "type", label: "", status: "done", detail: "sent" });
      fake.send({ t: "result", jobId: send.jobId, ok: true, value: { ok: true, reply: "Keys click, lid closes / the cloud remembers the thread / morning finds it done", url: "https://chatgpt.com/c/1" } });
      const done = await waitFor(async () => {
        const m = (await server.api(`/conversations/${chat.conversation.id}`)).messages.find((x: Frame) => x.id === chat.message.id);
        return ["done", "failed", "cancelled"].includes(m.status) ? m : null;
      }, 60_000);
      assert.equal(done?.status, "done", `the message settled (${done?.status}: ${done?.error ?? ""})`);
      assert.match(done!.response, /Keys click/);
      const run = await server.api(`/runs/${send.payload.runId}`);
      assert.equal(run.status, "success");
      assert.ok(run.steps.some((s: Frame) => s.key === "type" && s.status === "done" && s.detail === "sent"), "the connector's steps are the run's steps");
      assert.equal(run.output_url, "https://chatgpt.com/c/1");

      // The connector's browser snapshot is what the dashboard sees as the workspace's browser.
      fake.send({ t: "state", snapshot: { enabled: true, running: true, headless: false, active: "chatgpt", busy: null, pages: [{ platform: "chatgpt", url: "https://chatgpt.com/", title: "ChatGPT" }], signIn: null, seq: 1, epoch: "laptop" } });
      const shown = await waitFor(async () => {
        const b = await server.api("/browser");
        return b.pages?.length === 1 && b.pages[0].platform === "chatgpt" ? b : null;
      }, 10_000);
      assert.ok(shown, "the laptop's tab shows in the browser state");
      assert.equal(shown.epoch, "laptop");

      // Revoking the device cuts its socket and refuses the token from then on.
      const closed = new Promise<number>((resolve) => fake.ws.once("close", (code) => resolve(code)));
      await server.api(`/devices/${created.device.id}`, { method: "DELETE" });
      assert.equal(await closed, 4001);
      await assert.rejects(connectFake(server.base, created.token), /HTTP 401/);
      const after = (await server.api("/devices")).devices.find((d: Frame) => d.id === created.device.id);
      assert.equal(after.online, false);
      assert.ok(after.revoked_at);
      // With the computer gone and no browser here, the check says so instead of hanging.
      const status = (await server.api("/connections/chatgpt/check", { body: {} })).status;
      assert.notEqual(status, "logged_in");
    } finally {
      await server.stop();
    }
  });
});
