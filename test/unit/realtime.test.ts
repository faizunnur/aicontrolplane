import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { redisRateLimiter, redisTarget, startRedisBridge } from "../../packages/realtime/src/index.js";

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

  it("with Redis up, two bridges mirror events to each other", async (t) => {
    if (!(await redisUp())) return t.skip("no Redis at " + REDIS_URL);
    const a = new EventEmitter();
    const b = new EventEmitter();
    const channel = `acp:test:${Date.now()}`;
    const ba = await startRedisBridge(a, REDIS_URL, { channel });
    const bb = await startRedisBridge(b, REDIS_URL, { channel });
    assert.equal(ba.connected, true);
    assert.equal(bb.connected, true);
    const got = new Promise((resolve) => b.on("run", (p) => resolve(p)));
    a.emit("run", { id: 7 }, 42);
    assert.deepEqual(await got, { id: 7 });
    await ba.stop();
    await bb.stop();
  });
});
