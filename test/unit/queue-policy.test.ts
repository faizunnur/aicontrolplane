import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { handlerDeadlineMs, InlineQueue, QUEUE_DEFAULTS, resolveJobOptions } = await import("../../packages/queue/src/index.js");

describe("per-queue retry policy", () => {
  it("gives each queue its deliberate defaults", () => {
    assert.deepEqual(resolveJobOptions("task.start"), { retryLimit: 3, retryDelaySeconds: 30 });
    assert.equal(resolveJobOptions("run.resume").retryLimit, 3);
    assert.equal(resolveJobOptions("browser.run.resume").retryLimit, 3);
    assert.equal(resolveJobOptions("browser.chat.deliver").retryLimit, 2);
    assert.equal(resolveJobOptions("browser.chat.deliver").retryDelaySeconds, 60);
    assert.equal(resolveJobOptions("dispatch.deliver").retryLimit, 2);
    assert.equal(resolveJobOptions("webhook.deliver").retryLimit, 5);
    // Cron work is refired by its own schedule; a retry would only double it up.
    assert.equal(resolveJobOptions("browser.sync.platform").retryLimit, 0);
    assert.equal(resolveJobOptions("cron.maintenance").retryLimit, undefined);
  });

  it("lets an explicit send option win over the queue default", () => {
    const opts = resolveJobOptions("task.start", { retryLimit: 0, singletonKey: "x" });
    assert.equal(opts.retryLimit, 0);
    assert.equal(opts.retryDelaySeconds, 30, "unspecified fields keep the default");
    assert.equal(opts.singletonKey, "x");
  });

  it("an undefined option in the send never erases a default", () => {
    const opts = resolveJobOptions("task.start", { retryLimit: undefined });
    assert.equal(opts.retryLimit, 3);
  });

  it("watchdog deadlines: per-queue override, else expire minus grace, never under a minute", () => {
    assert.equal(handlerDeadlineMs("browser.chat.deliver"), QUEUE_DEFAULTS["browser.chat.deliver"].handlerTimeoutSeconds! * 1000);
    assert.equal(handlerDeadlineMs("task.start"), (15 * 60 - 30) * 1000);
    assert.equal(handlerDeadlineMs("cron.maintenance"), (15 * 60 - 30) * 1000);
    assert.ok(handlerDeadlineMs("browser.chat.deliver") >= 180_000, "the chat deadline covers the 120s reply wait plus navigation");
  });
});

describe("inline queue singleton keys", () => {
  it("runs at most one job per key at a time", async () => {
    const q = new InlineQueue();
    let calls = 0;
    q.work("job", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
    });
    // Fired without awaiting, the second send sees the key in flight and is dropped.
    const first = q.send("job", {}, { singletonKey: "k" });
    const second = q.send("job", {}, { singletonKey: "k" });
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    // The key frees once the job settles; the next send runs.
    await q.send("job", {}, { singletonKey: "k" });
    assert.equal(calls, 2);
  });

  it("a delayed job holds its key until it has actually run", async () => {
    const q = new InlineQueue();
    let calls = 0;
    q.work("job", async () => {
      calls++;
    });
    await q.send("job", {}, { singletonKey: "d", startAfterSeconds: 0.05 });
    await q.send("job", {}, { singletonKey: "d" }); // dropped: the delayed one is queued
    assert.equal(calls, 0);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls, 1);
  });

  it("keys never collide across different values", async () => {
    const q = new InlineQueue();
    let calls = 0;
    q.work("job", async () => {
      calls++;
    });
    await q.send("job", {}, { singletonKey: "a" });
    await q.send("job", {}, { singletonKey: "b" });
    await q.send("job", {});
    assert.equal(calls, 3);
  });
});
