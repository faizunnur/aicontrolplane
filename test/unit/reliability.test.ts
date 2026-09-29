import "../helpers/env.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const { beginRun, endRun, enforceRunQuotas, leaseOwner, QuotaExceededError, reapStaleRuns, withRunLease } = await import("../../src/runs.js");
const { signWebhookBody } = await import("../../src/deliver.js");
const { sweepStuckDeliveries } = await import("../../src/jobs.js");

const OLD = "2000-01-01T00:00:00.000Z";

describe("run leases", () => {
  it("withRunLease heartbeats while the executor works and clears the lease on the way out", async () => {
    const { run } = await beginRun({ kind: "chat", label: "leased work", provider: "custom" });
    await withRunLease(run.id, async () => {
      const live = (await db.getRun(run.id))!;
      assert.equal(live.locked_by, leaseOwner);
      assert.ok(live.lease_expires_at && live.lease_expires_at > new Date().toISOString(), "the lease reaches into the future");
    });
    // Still running (an open-on-purpose run): no executor, so no lease — the silence rule judges it.
    const after = (await db.getRun(run.id))!;
    assert.equal(after.status, "running");
    assert.equal(after.lease_expires_at, null);
    assert.equal(after.locked_by, null);
    await endRun(run.id, { status: "success", summary: "done" });
  });

  it("the reaper fails a running run whose lease expired, in minutes not half an hour", async () => {
    const { run } = await beginRun({ kind: "chat", label: "dead worker", provider: "custom" });
    await db.rawRun("UPDATE runs SET lease_expires_at = ?, locked_by = 'gone#1' WHERE id = ?", [OLD, run.id]);
    await reapStaleRuns();
    const reaped = (await db.getRun(run.id))!;
    assert.equal(reaped.status, "failed");
    assert.match(reaped.error ?? "", /stopped heartbeating/);
  });

  it("an actively leased run is never reaped, however silent its timeline", async () => {
    const { run } = await beginRun({ kind: "chat", label: "quietly alive", provider: "custom" });
    // An ancient timeline (well past the 30-minute silence rule) but a live lease.
    await db.rawRun("UPDATE runs SET created_at = ?, started_at = ? WHERE id = ?", [OLD, OLD, run.id]);
    await db.heartbeatRun(run.id, 5 * 60_000, "alive#1");
    await reapStaleRuns();
    assert.equal((await db.getRun(run.id))!.status, "running");
    await endRun(run.id, { status: "success", summary: "ok" });
  });

  it("a lease-less run keeps the legacy silence rule", async () => {
    const { run } = await beginRun({ kind: "external", label: "agent reports later", provider: "custom" });
    await db.rawRun("UPDATE runs SET created_at = ?, started_at = ? WHERE id = ?", [OLD, OLD, run.id]);
    // kind external: never reaped, whatever its age.
    await reapStaleRuns();
    assert.equal((await db.getRun(run.id))!.status, "running");
    await endRun(run.id, { status: "success", summary: "ok" });

    const { run: stale } = await beginRun({ kind: "chat", label: "silent and lease-less", provider: "custom" });
    await db.rawRun("UPDATE runs SET created_at = ?, started_at = ? WHERE id = ?", [OLD, OLD, stale.id]);
    await reapStaleRuns();
    const reaped = (await db.getRun(stale.id))!;
    assert.equal(reaped.status, "failed");
    assert.match(reaped.error ?? "", /stopped answering/);
  });
});

describe("workspace quotas", () => {
  const setQuotas = (q: unknown) => db.rawRun("UPDATE orgs SET quotas = ? WHERE id = 1", [q === null ? null : JSON.stringify(q)]);

  it("the concurrency cap throws retryable — the queue's backoff is the waiting room", async () => {
    const { run } = await beginRun({ kind: "chat", label: "occupies the slot", provider: "custom" });
    await setQuotas({ maxConcurrentRuns: 1 });
    try {
      await assert.rejects(enforceRunQuotas(), (err: unknown) => err instanceof QuotaExceededError && err.retryable && /concurrency limit/.test(err.message));
      // The run being started already counts itself: selfCounted must not self-block.
      await enforceRunQuotas({ selfCounted: true });
    } finally {
      await setQuotas(null);
      await endRun(run.id, { status: "success", summary: "ok" });
    }
  });

  it("the daily cap fails outright — no retry can help today", async () => {
    const { run } = await beginRun({ kind: "chat", label: "today's run", provider: "custom" });
    await endRun(run.id, { status: "success", summary: "ok" });
    await setQuotas({ maxRunsPerDay: 1 });
    try {
      await assert.rejects(enforceRunQuotas(), (err: unknown) => err instanceof QuotaExceededError && !err.retryable && /daily run limit/.test(err.message));
    } finally {
      await setQuotas(null);
    }
  });

  it("org quotas override the env defaults (which the test env sets to unlimited)", async () => {
    await enforceRunQuotas(); // unlimited by env: nothing throws
    await setQuotas({ maxConcurrentRuns: 10_000 });
    await enforceRunQuotas(); // an explicit generous org quota: still fine
    await setQuotas(null);
  });
});

describe("webhook signing", () => {
  it("signs v1=hex(hmac-sha256(token, ts.body)) over the exact raw body", () => {
    const { timestamp, signature } = signWebhookBody("hook-secret", '{"a":1}', 1_700_000_000);
    assert.equal(timestamp, "1700000000");
    assert.equal(signature, `v1=${createHmac("sha256", "hook-secret").update('1700000000.{"a":1}').digest("hex")}`);
  });

  it("a different body or timestamp changes the signature", () => {
    const a = signWebhookBody("k", "body", 1);
    const b = signWebhookBody("k", "body!", 1);
    const c = signWebhookBody("k", "body", 2);
    assert.notEqual(a.signature, b.signature);
    assert.notEqual(a.signature, c.signature);
  });
});

describe("stuck delivery sweep", () => {
  const age = (id: number) => db.rawRun("UPDATE messages SET created_at = ? WHERE id = ?", [OLD, id]);

  it("repairs a message whose run settled but whose row missed the news", async () => {
    const m = await db.createMessage("orphaned by a crash");
    const { run } = await beginRun({ kind: "chat", label: "carried it", provider: "custom", message_id: m.id });
    await endRun(run.id, { status: "failed", error: "boom" });
    await db.updateMessage(m.id, { status: "assigned", run_id: run.id });
    await age(m.id);
    await sweepStuckDeliveries();
    const fixed = (await db.getMessage(m.id))!;
    assert.equal(fixed.status, "failed");
    assert.equal(fixed.error, "boom");
  });

  it("leaves an unrouted message alone — that is the user's decision, not a lost job", async () => {
    const m = await db.createMessage("never routed anywhere");
    await age(m.id);
    await sweepStuckDeliveries();
    assert.equal((await db.getMessage(m.id))!.status, "needs_assignment");
  });

  it("fails a dispatched message it cannot re-route with a clear, user-visible error", async () => {
    // Manually routed, but the chosen platform was never recorded on the row and there are
    // no suggestions to fall back on: nothing honest to re-enqueue.
    const m = await db.createMessage("manual route, lost job");
    await db.updateMessage(m.id, { routing: { method: "manual", confidence: 1, reason: "You chose it." } });
    await age(m.id);
    await sweepStuckDeliveries();
    const failed = (await db.getMessage(m.id))!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /delivery could not be completed/);
  });

  it("stops re-enqueueing after the attempt cap and fails the message instead", async () => {
    const t = await db.upsertTask({ platform: "custom", key: "sweep-cap", name: "Sweep cap" });
    const m = await db.createMessage("kept getting lost");
    await db.updateMessage(m.id, { status: "assigned", task_id: t.id, routing: { method: "manual", delivery_attempts: 3 } });
    await age(m.id);
    await sweepStuckDeliveries();
    const failed = (await db.getMessage(m.id))!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /delivery could not be completed/);
  });

  it("re-enqueues a lost dispatch and counts the attempt on the message", async () => {
    const t = await db.upsertTask({ platform: "custom", key: "sweep-redeliver", name: "Sweep redeliver", delivery: { mode: "inbox" } });
    const m = await db.createMessage("the job vanished");
    await db.updateMessage(m.id, { status: "assigned", task_id: t.id });
    await age(m.id);
    await sweepStuckDeliveries();
    const after = (await db.getMessage(m.id))!;
    const routing = JSON.parse(after.routing ?? "{}") as { delivery_attempts?: number };
    assert.equal(routing.delivery_attempts, 1);
    // Inline mode executed the re-sent job on the spot: an inbox dispatch parks the message
    // as assigned with a fresh run waiting for the agent.
    assert.equal(after.status, "assigned");
    assert.ok(after.run_id, "the redelivered job opened a run");
    const run = (await db.getRun(after.run_id!))!;
    assert.equal(run.status, "running");
    await endRun(run.id, { status: "success", summary: "picked up" });
  });
});
