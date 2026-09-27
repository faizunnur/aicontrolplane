import "../helpers/env.js";
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

const { safeFetch, EgressBlockedError } = await import("../../packages/security/src/egress.js");

describe("egress guard", () => {
  it("strict mode refuses loopback, private, link-local and metadata addresses", async () => {
    for (const url of ["http://127.0.0.1:9/x", "http://10.1.2.3/x", "http://172.16.0.1/x", "http://192.168.1.1/x", "http://169.254.169.254/latest/meta-data", "http://localhost:9/x", "http://[::1]:9/x"]) {
      await assert.rejects(() => safeFetch(url, {}, { policy: "strict" }), EgressBlockedError, url);
    }
  });

  it("refuses non-http schemes and honours the allowlist", async () => {
    await assert.rejects(() => safeFetch("ftp://example.com/x", {}, { policy: "strict" }), EgressBlockedError);
    await assert.rejects(() => safeFetch("file:///etc/passwd", {}, { policy: "strict" }), EgressBlockedError);
    // Allowlisted host may resolve privately (it still has to answer).
    const srv = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await safeFetch(`http://localhost:${port}/`, { timeoutMs: 5_000 }, { policy: "strict", allowlist: ["localhost"] });
      assert.equal(await res.text(), "ok");
    } finally {
      srv.close();
    }
  });

  it("permissive mode reaches local receivers (self-hosted webhooks, tests)", async () => {
    const srv = http.createServer((_req, res) => res.end("here"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await safeFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 5_000 }, { policy: "permissive" });
      assert.equal(await res.text(), "here");
    } finally {
      srv.close();
    }
  });
});
