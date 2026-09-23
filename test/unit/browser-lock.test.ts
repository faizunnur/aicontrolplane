import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { browser } = await import("../../src/browser/manager.js");

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
