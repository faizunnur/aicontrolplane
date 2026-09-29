import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { browser } = await import("../../src/browser/manager.js");
const { FleetManager } = await import("../../src/browser/fleet.js");

describe("browser lock during a desktop sign-in", () => {
  it("refuses other browser work at once, with the reason, instead of queueing it behind the window", async () => {
    const inner = browser as unknown as { desktop: unknown; enabled: boolean };
    // A real sign-in spawns a window on a display; here the state alone is enough to test the gate.
    // Unit tests run with the browser disabled, so the join path is tested with the flag on.
    const wasEnabled = inner.enabled;
    inner.enabled = true;
    inner.desktop = { platform: "grok", url: "https://grok.com", since: new Date().toISOString(), pid: null };
    try {
      await assert.rejects(browser.withLock(async () => "ran", { label: "test" }), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /sign-in to grok is in progress/);
        assert.equal((err as { status?: number }).status, 409);
        return true;
      });
      assert.equal(browser.snapshot().signIn?.platform, "grok");
      // Asking for the same sign-in again joins it rather than being refused.
      assert.equal(await browser.startDesktopSignIn("grok", "Grok", "https://grok.com"), inner.desktop);
      await assert.rejects(browser.startDesktopSignIn("chatgpt", "ChatGPT", "https://chatgpt.com"), /already in progress/);
    } finally {
      inner.desktop = null;
      inner.enabled = wasEnabled;
    }
    assert.equal(await browser.withLock(async () => "ran", { label: "test" }), "ran", "work proceeds again once the sign-in is over");
  });
});

describe("fleet workspace scoping and serialisation", () => {
  it("fails closed outside a workspace scope instead of adopting a default", async () => {
    const fleet = new FleetManager();
    const saved = process.env.ACP_TEST_DEFAULT_ORG;
    delete process.env.ACP_TEST_DEFAULT_ORG; // the unit-test escape hatch off: the e2e reality
    try {
      assert.throws(() => fleet.snapshot(), /outside a workspace scope/);
      // withLock refuses before it queues anything: the throw is synchronous on purpose.
      assert.throws(() => fleet.withLock(async () => "never"), /outside a workspace scope/);
    } finally {
      if (saved === undefined) delete process.env.ACP_TEST_DEFAULT_ORG;
      else process.env.ACP_TEST_DEFAULT_ORG = saved;
    }
    const { withOrg } = await import("../../src/db.js");
    assert.equal(withOrg(7, () => fleet.snapshot()).pages.length, 0, "a scoped caller sees its own (empty) view");
  });

  it("serialises jobs on a chain that survives a failed predecessor", async () => {
    const fleet = new FleetManager();
    const order: number[] = [];
    const first = fleet.withLock(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const second = fleet.withLock(async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, [1, 2], "the second job waited for the first");
    await assert.rejects(fleet.withLock(async () => {
      throw new Error("boom");
    }), /boom/);
    assert.equal(await fleet.withLock(async () => "after"), "after", "a failed job never wedges the chain");
  });
});
