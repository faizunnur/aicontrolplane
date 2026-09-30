import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Page } from "playwright";
import type { PlatformConfig } from "../../packages/core/src/index.js";

const { getProvider, listProviders, providerView } = await import("../../src/providers/registry.js");
const { detectLoginState } = await import("../../src/providers/browser/login.js");
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

  it("declares honest capabilities: browser for chat and task pages, nothing for task control", async () => {
    const c = getProvider("chatgpt")!.capabilities();
    assert.equal(c.chat, "browser");
    assert.equal(c.listTasks, "browser");
    for (const op of ["createTask", "updateTask", "cancelTask", "runTask", "getRun"] as const) assert.equal(c[op], null, `${op} must be unsupported`);
    const g = getProvider("gemini")!.capabilities();
    assert.equal(g.listTasks, null, "Gemini has no tasks page address, so listing is unsupported");
    const view = await providerView(getProvider("gemini")!);
    assert.ok(view.unsupported.find((u) => u.operation === "listTasks")?.reason.includes("AI setup"));
  });

  it("capabilities follow configuration changes without rebuilding the registry", async () => {
    await savePlatformOverride("gemini", { tasksUrl: "https://gemini.google.com/app/scheduled" });
    try {
      assert.equal(getProvider("gemini")!.capabilities().listTasks, "browser");
    } finally {
      await deletePlatformOverride("gemini");
    }
    assert.equal(getProvider("gemini")!.capabilities().listTasks, null);
  });

  it("a provider added by hand gets the generic browser adapter", async () => {
    await savePlatformOverride("muse", { name: "Muse", appUrl: "https://muse.example/", chatUrl: "https://muse.example/", composerSelector: "textarea", hidden: false });
    try {
      const a = getProvider("muse")!;
      assert.equal(a.kind, "browser");
      assert.equal(a.builtin, false);
      assert.deepEqual(a.aliases, ["muse"]);
      assert.equal(a.capabilities().chat, "browser");
      assert.equal(a.capabilities().listTasks, null);
    } finally {
      await deletePlatformOverride("muse");
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

  it("providers declare the sign-in mode they need, and a remembered mode wins", async () => {
    const { setSetting } = await import("../../src/db.js");
    assert.equal(await getProvider("grok")!.preferredSignIn(), "local", "Grok's sign-in page refuses any browser in a datacenter: sign in from your own computer");
    assert.equal(await getProvider("chatgpt")!.preferredSignIn(), "live");
    await setSetting("signin_mode:chatgpt", "desktop");
    assert.equal(await getProvider("chatgpt")!.preferredSignIn(), "desktop");
    await setSetting("signin_mode:chatgpt", "local");
    assert.equal(await getProvider("chatgpt")!.preferredSignIn(), "local", "a sign-in that worked from the user's computer is remembered");
    await setSetting("signin_mode:chatgpt", "nonsense");
    assert.equal(await getProvider("chatgpt")!.preferredSignIn(), "live", "an unknown remembered mode falls back to the provider's default");
    await setSetting("signin_mode:chatgpt", "live");
    assert.equal(await getProvider("chatgpt")!.preferredSignIn(), "live");
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

describe("login detection", () => {
  // A page is its answers to the selectors the detector asks about; nothing else matters here.
  const fakePage = (opts: { url?: string; present?: string[] } = {}): Page =>
    ({
      url: () => opts.url ?? "https://muse.example/app",
      locator: (sel: string) => ({
        count: async () => (opts.present?.includes(sel) ? 1 : 0),
        first: () => ({ isVisible: async () => opts.present?.includes(sel) ?? false }),
      }),
    }) as unknown as Page;
  const platform = (over: Partial<PlatformConfig> = {}): PlatformConfig =>
    ({ loginUrlPatterns: ["/login"], loggedInSelector: "nav .me", loggedOutSelector: "", sessionCookie: "", cookieDomain: "", composerSelector: "textarea" as string, ...over }) as unknown as PlatformConfig;

  it("believes the page's own signed-in evidence", async () => {
    assert.equal(await detectLoginState(platform(), fakePage({ present: ["nav .me"] })), "logged_in");
    assert.equal(await detectLoginState(platform(), fakePage({ present: ["textarea"] })), "logged_in", "the configured composer is signed-in evidence too");
    assert.equal(await detectLoginState(platform(), fakePage({ url: "https://muse.example/login" })), "needs_login");
  });

  it("a page missing every configured signed-in marker is unknown, never logged_in", async () => {
    // The old default answered logged_in here, so an unrecognised logged-out page masqueraded
    // as a session and the chat died with a generic timeout instead of needs_login.
    assert.equal(await detectLoginState(platform(), fakePage()), "unknown");
    assert.equal(await detectLoginState(platform({ composerSelector: "" }), fakePage()), "unknown");
    assert.equal(await detectLoginState(platform({ loggedInSelector: "" }), fakePage()), "unknown");
  });

  it("a provider with no markers at all is unknown — nothing can vouch for a session", async () => {
    // The old default answered logged_in, so a freshly added provider showed "Connected"
    // while its site sat on a login page. Unknown keeps the card honest; the chat path
    // still proceeds and flips the state to logged_in when its composer really appears.
    assert.equal(await detectLoginState(platform({ loggedInSelector: "", composerSelector: "" }), fakePage()), "unknown");
  });
});
