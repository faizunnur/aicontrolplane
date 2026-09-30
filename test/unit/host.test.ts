import "../helpers/env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ConnectorHost } from "../../src/browser/host.js";

const { host, setHost } = await import("../../src/browser/host.js");
const { PageController } = await import("../../src/browser/page.js");

/*
  The host seam: browser code reaches the outside world only through ConnectorHost, so it can
  run in a process with no database (the desktop connector). Two guarantees: the import graph
  of the browser code stays free of the database, and the flows really do call the host.
*/

/** The modules that must load where there is no database. */
const CONNECTOR_FILES = [
  "src/browser/executable.ts",
  "src/browser/fleet.ts",
  "src/browser/host.ts",
  "src/browser/live-stream.ts",
  "src/browser/manager.ts",
  "src/browser/page.ts",
  ...fs.readdirSync("src/providers/browser").map((f) => `src/providers/browser/${f}`),
];
/**
 * Static imports of modules whose loading opens or requires the database. A dynamic
 * `import()` is not an edge in the static graph (host.ts reaches host-local.ts that way, on
 * first use, only in a process that has a database), so only `from` clauses count.
 */
const FORBIDDEN = /from\s+["'][^"']*\/(?:db|persist|platforms|runs|secrets|session-store|host-local)\.js["']/;

const noop: ConnectorHost = {
  setPlatformState: async () => undefined,
  addCapture: async () => undefined,
  pruneCaptures: async () => undefined,
  saveScreenshot: async () => "unused",
  loadSessionState: async () => null,
  saveSessionState: async () => undefined,
  claimProvider: async () => true,
  renewProviderClaim: async () => true,
  releaseProviderClaim: async () => undefined,
  platform: async () => undefined,
  audit: async () => undefined,
  isCancelled: async () => false,
};

describe("the host seam", () => {
  afterEach(() => setHost(null));

  it("keeps the browser code's import graph free of the database", () => {
    for (const file of CONNECTOR_FILES) {
      // Type-only imports are erased by the compiler and never load a module.
      const src = fs.readFileSync(path.resolve(file), "utf8").replace(/import\s+type\b[\s\S]*?from\s+["'][^"']+["'];/g, "");
      const offending = src.split("\n").filter((l) => FORBIDDEN.test(l));
      assert.deepEqual(offending, [], `${file} reaches the database directly:\n${offending.join("\n")}`);
    }
  });

  it("routes a screenshot through the host and returns where the host put it", async () => {
    const calls: [string, number][] = [];
    setHost({ ...noop, saveScreenshot: async (id, png) => (calls.push([id, png.length]), "/shots/1/chatgpt.png") });
    const pc = new PageController("chatgpt", "ChatGPT");
    const page = { screenshot: async () => Buffer.from("png-bytes") };
    assert.equal(await pc.screenshot(page as never), "/shots/1/chatgpt.png");
    assert.deepEqual(calls, [["chatgpt", 9]]);
  });

  it("never throws from a screenshot, even when the host does", async () => {
    setHost({ ...noop, saveScreenshot: async () => Promise.reject(new Error("disk full")) });
    const pc = new PageController("grok", "Grok");
    assert.equal(await pc.screenshot({ screenshot: async () => Buffer.alloc(1) } as never), null);
  });

  it("falls back to the database host when none is installed", async () => {
    setHost(null);
    await host().setPlatformState("chatgpt", { last_error: "seam check" });
    const { getPlatformState } = await import("../../src/db.js");
    assert.equal((await getPlatformState("chatgpt")).last_error, "seam check");
    assert.equal(await host().claimProvider("chatgpt", "me", 1_000), true);
    await host().releaseProviderClaim("chatgpt", "me");
  });
});
