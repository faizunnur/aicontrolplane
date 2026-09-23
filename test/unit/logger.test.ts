import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { bus } = await import("../../src/bus.js");
const { logger, logLevel, logScopes, recentLogs, setLogLevel } = await import("../../src/logger.js");

describe("logger", () => {
  it("keeps every line in memory whatever the console prints, and announces it on the bus", () => {
    const seen: unknown[] = [];
    const listen = (l: unknown) => seen.push(l);
    bus.on("log", listen);
    const before = logLevel();
    try {
      setLogLevel("error"); // the console goes quiet; the buffer must not
      const log = logger("test-scope");
      log.debug("a debug line");
      log.info("an info line", { detail: 1 });
      log.warn("a warning");
      log.error("a failure", new Error("boom"));
      const all = recentLogs({ scope: "test-scope" });
      assert.deepEqual(all.map((l) => l.level), ["debug", "info", "warn", "error"]);
      assert.equal(all[1].extra, '{"detail":1}');
      assert.match(all[3].extra ?? "", /boom/);
      assert.deepEqual(recentLogs({ scope: "test-scope", level: "warn" }).map((l) => l.msg), ["a warning", "a failure"]);
      assert.ok(logScopes().includes("test-scope"));
      assert.ok(seen.length >= 4, "each line is announced for the live stream");
      const after = recentLogs({ scope: "test-scope", after: all[1].id });
      assert.deepEqual(after.map((l) => l.msg), ["a warning", "a failure"], "a cursor returns only what came after it");
    } finally {
      bus.off("log", listen);
      setLogLevel(before);
    }
  });

  it("refuses an unknown console level", () => {
    assert.throws(() => setLogLevel("verbose"), /level must be/);
  });
});
