import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { getProvider, listProviders, providerView } = await import("../../src/providers/registry.js");
const { UnsupportedOperationError } = await import("../../src/providers/types.js");
const { savePlatformOverride, deletePlatformOverride } = await import("../../src/platforms.js");
const { normalizePayloads } = await import("../../src/providers/browser/normalize.js");

describe("provider registry", () => {
  it("lists the built-in providers with their kinds", () => {
    const ids = listProviders().map((a) => a.id);
    for (const id of ["chatgpt", "claude", "grok", "gemini"]) assert.ok(ids.includes(id), `missing ${id}`);
    assert.ok(!ids.includes("custom"), "custom agents are hidden from the connections list");
    assert.equal(getProvider("custom")?.kind, "custom");
    assert.equal(getProvider("chatgpt")?.kind, "browser");
    assert.equal(getProvider("nope"), undefined);
  });

  it("declares honest capabilities: browser for chat and task pages, nothing for task control", () => {
    const c = getProvider("chatgpt")!.capabilities();
    assert.equal(c.chat, "browser");
    assert.equal(c.listTasks, "browser");
    for (const op of ["createTask", "updateTask", "cancelTask", "runTask", "getRun"] as const) assert.equal(c[op], null, `${op} must be unsupported`);
    const g = getProvider("gemini")!.capabilities();
    assert.equal(g.listTasks, null, "Gemini has no tasks page address, so listing is unsupported");
    const view = providerView(getProvider("gemini")!);
    assert.ok(view.unsupported.find((u) => u.operation === "listTasks")?.reason.includes("AI setup"));
  });

  it("capabilities follow configuration changes without rebuilding the registry", () => {
    savePlatformOverride("gemini", { tasksUrl: "https://gemini.google.com/app/scheduled" });
    try {
      assert.equal(getProvider("gemini")!.capabilities().listTasks, "browser");
    } finally {
      deletePlatformOverride("gemini");
    }
    assert.equal(getProvider("gemini")!.capabilities().listTasks, null);
  });

  it("a provider added by hand gets the generic browser adapter", () => {
    savePlatformOverride("muse", { name: "Muse", appUrl: "https://muse.example/", chatUrl: "https://muse.example/", composerSelector: "textarea", hidden: false });
    try {
      const a = getProvider("muse")!;
      assert.equal(a.kind, "browser");
      assert.equal(a.builtin, false);
      assert.deepEqual(a.aliases, ["muse"]);
      assert.equal(a.capabilities().chat, "browser");
      assert.equal(a.capabilities().listTasks, null);
    } finally {
      deletePlatformOverride("muse");
    }
  });

  it("unsupported operations are structured errors, not fakes", async () => {
    const custom = getProvider("custom")!;
    await assert.rejects(() => custom.sendMessage("hi", {}), (err: unknown) => {
      assert.ok(err instanceof UnsupportedOperationError);
      assert.equal(err.status, 501);
      assert.deepEqual(Object.keys(err.toJSON()), ["error", "provider", "operation", "reason"]);
      assert.equal(err.operation, "chat");
      return true;
    });
    await assert.rejects(() => getProvider("grok")!.runTask({ id: 1, key: "k", name: "n", configuration: {} }, {}), UnsupportedOperationError);
    assert.equal(getProvider("claude")!.capabilities().runTask, "api", "Claude routines can be fired through their documented trigger");
    assert.equal(getProvider("claude")!.canRunTask({ id: 1, key: "k", name: "n", configuration: {} }).ok, false, "but only once the task holds its fire URL and token");
  });

  it("aliases are what the router recognises", () => {
    assert.ok(getProvider("chatgpt")!.aliases.includes("gpt"));
    assert.ok(getProvider("claude")!.aliases.includes("anthropic"));
    assert.ok(getProvider("grok")!.aliases.includes("x.ai"));
    assert.ok(getProvider("gemini")!.aliases.includes("bard"));
  });

  it("provider rules stay inside the adapter: ChatGPT's conversation link", () => {
    const chatgpt = getProvider("chatgpt")!;
    assert.equal(chatgpt.outputUrlFor({ conversation_id: "abc" }), "https://chatgpt.com/c/abc");
    assert.equal(getProvider("claude")!.outputUrlFor({ conversation_id: "abc" }), null);
    const payload = { tasks: [{ id: "t", name: "T", schedule: "daily", runs: [{ id: "r", status: "done", finished_at: "2026-09-01T00:00:00Z", conversation_id: "zzz" }] }] };
    const withHook = normalizePayloads(chatgpt.config(), [payload], { outputUrlFor: (raw) => chatgpt.outputUrlFor(raw) });
    assert.equal(withHook.runs[0].output_url, "https://chatgpt.com/c/zzz");
    const without = normalizePayloads(getProvider("claude")!.config(), [payload]);
    assert.equal(without.runs[0].output_url, null);
  });
});
