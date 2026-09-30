import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connector } from "../../src/gateway/registry.js";

const db = await import("../../src/db.js");
const devices = await import("../../src/devices.js");
const gateway = await import("../../src/gateway/server.js");
const proto = await import("../../packages/core/src/gateway.js");
const { beginRun } = await import("../../src/runs.js");

const owner = { id: 1, email: "owner@test", role: "owner" as const, orgId: 1 };

/** A connector with no socket behind it: what handleFrame sees. */
const fakeConnector = (org: number): Connector => ({
  org,
  deviceId: 9,
  name: "Fake laptop",
  app: "test",
  version: "0",
  os: "test",
  chrome: null,
  providers: [],
  connectedAt: new Date().toISOString(),
  send() {},
  sendBinary() {},
  close() {},
});

describe("gateway", () => {
  it("binary envelopes carry a JSON header line and the raw bytes", () => {
    const buf = proto.packEnvelope({ t: "frame", platform: "chatgpt" }, Buffer.from([1, 2, 3]));
    const { header, body } = proto.unpackEnvelope(buf);
    assert.deepEqual(header, { t: "frame", platform: "chatgpt" });
    assert.deepEqual([...body], [1, 2, 3]);
    assert.equal(proto.unpackEnvelope(proto.packEnvelope({ t: "x" })).body.length, 0);
  });

  it("device tokens are shown once, kept only as a hash, and die on revocation", async () => {
    const { device, token } = await devices.createDevice("Laptop", owner);
    assert.match(token, /^acp_dev_[0-9a-f]{48}$/);
    const stored = await db.rawAll<{ token_hash: string }>("SELECT token_hash FROM devices");
    assert.ok(!stored.some((r) => r.token_hash === token), "only the hash is stored");
    assert.equal((await devices.deviceFromToken(token))?.id, device.id);
    assert.equal(await devices.deviceFromToken("acp_dev_" + "0".repeat(48)), undefined);
    assert.equal(await devices.deviceFromToken("not a device token"), undefined);
    assert.equal(await devices.deviceFromToken(undefined), undefined);
    assert.equal((await devices.listDevicesView()).find((d) => d.id === device.id)?.online, false);
    await devices.revokeDevice(device.id, owner.email);
    assert.equal(await devices.deviceFromToken(token), undefined, "a revoked token opens nothing");
    assert.ok((await devices.listDevicesView()).find((d) => d.id === device.id)?.revoked_at);
    assert.ok((await db.listAudit({ limit: 10 })).some((a) => a.action === "device.revoked"), "revocation is audited");
  });

  it("a run event from a device lands only on a run of its own workspace", async () => {
    const { run } = await beginRun({ kind: "chat", label: "gateway", provider: "mock" });
    await gateway.handleFrame(fakeConnector(2), { t: "run-event", runId: run.id, key: "type", label: "From another workspace", status: "running" });
    assert.ok(!db.foldSteps(await db.runEvents(run.id)).some((s) => s.key === "type"), "another workspace's connector cannot write here");
    await gateway.handleFrame(fakeConnector(1), { t: "run-event", runId: run.id, key: "type", label: "Typing", status: "running" });
    await gateway.handleFrame(fakeConnector(1), { t: "run-event", runId: run.id, key: "type", label: "", status: "done", detail: "sent" });
    const step = db.foldSteps(await db.runEvents(run.id)).find((s) => s.key === "type");
    assert.equal(step?.status, "done");
    assert.equal(step?.detail, "sent");
  });

  it("platform frames may set session fields, never the server's screenshot path", async () => {
    await gateway.handleFrame(fakeConnector(1), { t: "platform", platformId: "chatgpt", patch: { session_status: "logged_in", last_error: null, screenshot_path: "/etc/passwd" } });
    const state = await db.getPlatformState("chatgpt");
    assert.equal(state.session_status, "logged_in");
    assert.notEqual(state.screenshot_path, "/etc/passwd");
  });

  it("a job cannot be answered by a device it was not sent to, and fails fast when the computer is gone", async () => {
    const { registerConnector, unregisterConnector } = await import("../../src/gateway/registry.js");
    const sent: unknown[] = [];
    const conn: Connector = { ...fakeConnector(1), deviceId: 11, send: (f) => sent.push(f) };
    registerConnector(conn);
    try {
      const call = gateway.gatewayCall<string>(1, "auth.check", { platformId: "chatgpt" }, 5_000);
      const job = sent.find((f) => (f as { t: string }).t === "job") as { jobId: string } | undefined;
      assert.ok(job, "the job went to the connector");
      await gateway.handleFrame({ ...fakeConnector(1), deviceId: 12 }, { t: "result", jobId: job.jobId, ok: true, value: "logged_in" });
      // Still pending: the other device's answer was ignored.
      await gateway.handleFrame(conn, { t: "result", jobId: job.jobId, ok: true, value: "logged_in" });
      assert.equal(await call, "logged_in");
      const failing = gateway.gatewayCall<string>(1, "auth.check", {}, 5_000);
      const job2 = sent.filter((f) => (f as { t: string }).t === "job").at(-1) as { jobId: string };
      await gateway.handleFrame(conn, { t: "result", jobId: job2.jobId, ok: false, error: "Chrome is not installed" });
      await assert.rejects(failing, (err: Error & { status?: number }) => err.message === "Chrome is not installed" && err.status === 502);
    } finally {
      unregisterConnector(conn);
    }
    await assert.rejects(gateway.gatewayCall(1, "auth.check", {}, 1_000), (err: Error & { status?: number }) => /not connected/.test(err.message) && err.status === 503);
  });
});
