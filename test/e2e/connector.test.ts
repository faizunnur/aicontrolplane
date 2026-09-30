/**
 * The desktop runtime, end to end: the server holds no browser; a connector process with
 * its own headless Chromium pairs with a device token and does the workspace's browser
 * work — the sign-in check, a chat against the mock AI site, the screencast state and the
 * screenshot — while the control plane keeps the bookkeeping.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MOCK_SELECTORS, startMockProvider } from "../helpers/mock-provider.js";
import { startConnector, startServer, waitFor } from "../helpers/server.js";

describe("connector: this computer's Chrome is the workspace's browser", { timeout: 300_000 }, () => {
  it("checks the sign-in, chats, and reports state and screenshots from its own browser", async () => {
    const mock = await startMockProvider();
    const server = await startServer({ BROWSER_ENABLED: "false" });
    let connector: Awaited<ReturnType<typeof startConnector>> | null = null;
    try {
      const created = await server.api("/devices", { body: { name: "CI laptop" } });
      connector = await startConnector({ ACP_URL: server.base, ACP_DEVICE_TOKEN: created.token });
      const online = await waitFor(async () => (await server.api("/devices")).devices.find((d: any) => d.id === created.device.id && d.online), 30_000);
      assert.ok(online, "the connector is listed online");

      // A provider configured after the connector arrived: the job carries the fresh config.
      await server.api("/connections", { body: { name: "Mock AI", appUrl: mock.url, purpose: "testing" } });
      await server.api("/connections/mock-ai", { method: "PUT", body: { ...MOCK_SELECTORS, chatUrl: mock.url } });
      const check = await server.api("/connections/mock-ai/check", { body: {} });
      assert.equal(check.status, "logged_in", "the sign-in check ran in the connector's Chrome");

      const chat = await server.api("/chat", { body: { text: "Hello from the cloud", platform: "mock-ai" } });
      const done = await waitFor(async () => {
        const m = (await server.api(`/conversations/${chat.conversation.id}`)).messages.find((x: any) => x.id === chat.message.id);
        return ["done", "failed", "cancelled"].includes(m.status) ? m : null;
      }, 120_000);
      assert.equal(done?.status, "done", `the connector delivered it (got ${done?.status}: ${done?.error ?? ""})`);
      assert.match(done!.response, /You said: Hello from the cloud/);

      // The run's steps came from the connector, over the gateway.
      const list = await server.api("/runs?limit=20");
      const runs: any[] = Array.isArray(list) ? list : (list.runs ?? list.items ?? []);
      const run = runs.find((r) => r.message_id === chat.message.id);
      assert.ok(run, "the chat has a run");
      const detail = await server.api(`/runs/${run.id}`);
      assert.equal(detail.status, "success");
      assert.ok(detail.steps.some((s: any) => s.status === "done"), `steps reported by the connector: ${detail.steps.map((s: any) => `${s.key}:${s.status}`).join(", ")}`);

      // Its browser snapshot is the workspace's, and its screenshot landed where the web app reads it.
      const snap = await waitFor(async () => {
        const b = await server.api("/browser");
        return b.pages?.some((p: any) => p.platform === "mock-ai") ? b : null;
      }, 20_000);
      assert.ok(snap, "the connector's tab shows as the workspace's browser");
      const shot = await waitFor(async () => {
        const r = await server.raw("/api/platforms/mock-ai/screenshot.png");
        return r.status === 200 ? r : null;
      }, 20_000);
      assert.ok(shot, "the screenshot the connector took is served by the cloud");

      // Gone: the workspace has no browser again, and says so.
      await connector.stop();
      connector = null;
      await waitFor(async () => !(await server.api("/devices")).devices.find((d: any) => d.id === created.device.id).online, 20_000);
      const after = await server.api("/connections/mock-ai/check", { body: {} });
      assert.notEqual(after.status, "logged_in");
    } finally {
      if (connector) await connector.stop();
      await server.stop();
      await mock.close();
    }
  });
});
