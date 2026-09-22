import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { cleanError, isStall } = await import("../../src/browser/page.js");

describe("page controller helpers", () => {
  it("keeps the readable first line of a Playwright error", () => {
    const err = new Error("\u001b[31mpage.goto: Timeout 45000ms exceeded.\u001b[0m\nCall log:\n  - navigating to …");
    assert.equal(cleanError(err), "page.goto: Timeout 45000ms exceeded.");
    assert.equal(cleanError("plain"), "plain");
  });

  it("recognises a stalled tab, and nothing else, as retryable", () => {
    assert.ok(isStall(new Error("page.goto: Timeout 45000ms exceeded.")));
    assert.ok(isStall(new Error("Target page, context or browser has been closed")));
    assert.ok(isStall(new Error("Page crashed")));
    assert.ok(!isStall(new Error("locator.click: strict mode violation")));
    assert.ok(!isStall(new Error("net::ERR_NAME_NOT_RESOLVED")));
  });
});
