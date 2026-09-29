import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  EVENT_SHARDS,
  MIRRORED_TOPICS,
  eventChannelFor,
  eventShardOf,
  liveFrameChannel,
  packEnvelope,
  redisRateLimiter,
  redisTarget,
  startRedisBridge,
  unpackEnvelope,
  unwatchOrgEvents,
  watchOrgEvents,
  watchedOrgs,
} from "../../packages/realtime/src/index.js";

const UNREACHABLE = "redis://127.0.0.1:1";
const REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:56379";

async function redisUp(): Promise<boolean> {
  const net = await import("node:net");
  const u = new URL(REDIS_URL);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 6379) }, () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
}

/** Emit `send()` every 100ms until `received` resolves (pub/sub races SUBSCRIBE acks) or time runs out. */
async function pump<T>(send: () => void, received: Promise<T>, timeoutMs = 4_000): Promise<T | "timeout"> {
  let done = false;
  void received.finally(() => (done = true));
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs).unref?.());
  void (async () => {
    while (!done) {
      send();
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return Promise.race([received, timeout]);
}

describe("event channels are sharded by workspace", () => {
  it("maps a workspace to a stable shard and channel; the founding workspace rides the system channel", () => {
    assert.equal(eventChannelFor(undefined), "acp:1:events:sys");
    assert.equal(eventChannelFor(1), "acp:1:events:sys");
    assert.equal(eventChannelFor(2), `acp:1:events:${2 % EVENT_SHARDS}`);
    assert.equal(eventChannelFor(2), "acp:1:events:2");
    assert.equal(eventChannelFor(2 + EVENT_SHARDS), "acp:1:events:2"); // orgs 16 apart share a shard
    assert.equal(eventChannelFor(3, "test:pfx"), "test:pfx:3");
    assert.equal(EVENT_SHARDS, 16, "both sides must agree on the shard count forever");
    for (let org = 2; org < 200; org++) {
      const s = eventShardOf(org);
      assert.ok(s >= 0 && s < EVENT_SHARDS);
      assert.equal(s, eventShardOf(org), "stable");
    }
  });

  it("mirrors vnc-owner and resync, and no longer mirrors browser snapshots (the relay's state channel carries those)", () => {
    assert.ok(MIRRORED_TOPICS.includes("vnc-owner"), "vnc-owner must cross the bridge so an api can cut foreign VNC sockets");
    assert.ok(MIRRORED_TOPICS.includes("resync"), "an outbox overflow anywhere must reach that workspace's SSE clients");
    assert.ok(!(MIRRORED_TOPICS as readonly string[]).includes("browser"), "snapshots travel org-tagged over the live relay instead");
  });

  it("keeps a per-org refcount; org 1 never counts (its channel is always on)", () => {
    watchOrgEvents(1);
    assert.ok(!watchedOrgs().includes(1));
    watchOrgEvents(7);
    watchOrgEvents(7);
    assert.ok(watchedOrgs().includes(7));
    unwatchOrgEvents(7);
    assert.ok(watchedOrgs().includes(7), "one of two watchers left");
    unwatchOrgEvents(7);
    assert.ok(!watchedOrgs().includes(7));
  });
});

describe("the frame envelope: one JSON header line, then raw bytes", () => {
  it("round-trips a header with a binary body, including newlines inside the body", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x0a, 0x00, 0x0a, 0xff, 0xd9]); // newlines in the body must not split the header
    const meta = { platform: "chatgpt", url: "https://chatgpt.com", title: "a\ntitle", width: 1280, height: 900 };
    const wire = packEnvelope({ platform: "chatgpt", org: 3, meta, metaChanged: true }, jpeg);
    const { header, body } = unpackEnvelope(wire);
    assert.equal(header.platform, "chatgpt");
    assert.equal(header.org, 3);
    assert.deepEqual(header.meta, meta);
    assert.equal(header.metaChanged, true);
    assert.ok(Buffer.isBuffer(body));
    assert.deepEqual([...body], [...jpeg]);
  });

  it("carries a header-only message (errors) with an empty body", () => {
    const { header, body } = unpackEnvelope(packEnvelope({ platform: "claude", org: 2, error: "no such tab" }));
    assert.equal(header.error, "no such tab");
    assert.equal(body.length, 0);
  });

  it("names one channel per (workspace, tab)", () => {
    assert.equal(liveFrameChannel(4, "chatgpt"), "acp:1:frame:4:chatgpt");
    assert.notEqual(liveFrameChannel(4, "chatgpt"), liveFrameChannel(5, "chatgpt"));
  });
});

describe("redis is optional: the process runs without it", () => {
  it("names where a URL points, without the password, and flags an empty reference", () => {
    assert.equal(redisTarget("redis://default:secret@redis.railway.internal:6379?family=0"), "redis.railway.internal:6379");
    assert.equal(redisTarget("redis://cache"), "cache:6379");
    assert.equal(redisTarget("?family=0"), "(REDIS_URL is not a valid URL)");
  });

  it("starting the bridge against an unreachable Redis resolves, does not throw, and reports once", async () => {
    const errors: string[] = [];
    const t0 = Date.now();
    const bridge = await startRedisBridge(new EventEmitter(), UNREACHABLE, { graceMs: 700, onError: (e) => errors.push(String(e)) });
    assert.equal(bridge.connected, false);
    assert.ok(Date.now() - t0 < 3_000, "startup waits only for the grace period");
    await new Promise((r) => setTimeout(r, 1_500)); // several reconnect attempts
    assert.ok(errors.length >= 1 && errors.length <= 2, `errors are throttled (got ${errors.length})`);
    assert.match(errors[0], /127\.0\.0\.1:1/, "the error names the target");
    await bridge.stop();
  });

  it("the shared rate limiter fails fast while Redis is down (callers then count locally)", async () => {
    const limit = redisRateLimiter(UNREACHABLE);
    const t0 = Date.now();
    await assert.rejects(() => limit("probe", 60_000));
    assert.ok(Date.now() - t0 < 1_000, "no queueing behind a dead connection");
    limit.close();
  });

  it("with Redis up, two bridges mirror an org's events over its shard channel", async (t) => {
    if (!(await redisUp())) return t.skip("no Redis at " + REDIS_URL);
    const a = new EventEmitter();
    const b = new EventEmitter();
    const prefix = `acp:test:${Date.now()}`;
    const ba = await startRedisBridge(a, REDIS_URL, { prefix });
    const bb = await startRedisBridge(b, REDIS_URL, { prefix }); // default mode: every shard
    assert.equal(ba.connected, true);
    assert.equal(bb.connected, true);
    const got = new Promise<[unknown, unknown, unknown]>((resolve) => b.on("run", (p, id, org) => resolve([p, id, org])));
    const result = await pump(() => a.emit("run", { id: 7 }, 42, 5), got);
    assert.notEqual(result, "timeout", "the org-5 event crossed on its shard");
    assert.deepEqual(result, [{ id: 7 }, 42, 5]);
    await ba.stop();
    await bb.stop();
  });

  it("with Redis up, an on-demand subscriber only hears a workspace while someone watches it", async (t) => {
    if (!(await redisUp())) return t.skip("no Redis at " + REDIS_URL);
    const a = new EventEmitter();
    const b = new EventEmitter();
    const prefix = `acp:test:od:${Date.now()}`;
    const ba = await startRedisBridge(a, REDIS_URL, { prefix });
    const bb = await startRedisBridge(b, REDIS_URL, { prefix, subscribe: "on-demand", lingerMs: 50 });
    let heard = 0;
    b.on("task", () => heard++);

    // Nobody watches org 5: its events must not arrive here.
    for (let i = 0; i < 5; i++) {
      a.emit("task", { i }, undefined, 5);
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(heard, 0, "no subscription, no parsing");

    // The system channel is always on: an install-level vnc-owner change arrives regardless.
    const gotOwner = new Promise((resolve) => b.on("vnc-owner", (p) => resolve(p)));
    assert.deepEqual(await pump(() => a.emit("vnc-owner", { org: 9 }), gotOwner), { org: 9 }, "vnc-owner crosses the bridge with no org watched");

    // A client shows up: the shard follows.
    watchOrgEvents(5);
    try {
      const gotTask = new Promise((resolve) => b.on("approval", (p) => resolve(p)));
      assert.deepEqual(await pump(() => a.emit("approval", { id: 1 }, undefined, 5), gotTask), { id: 1 });
    } finally {
      unwatchOrgEvents(5);
    }

    // The last client left; after the linger the shard is let go again.
    await new Promise((r) => setTimeout(r, 300));
    const before = heard;
    for (let i = 0; i < 5; i++) {
      a.emit("task", { i }, undefined, 5);
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(heard, before, "unsubscribed after the linger");

    await ba.stop();
    await bb.stop();
  });
});
