import "../helpers/env.js";
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

const { safeFetch, EgressBlockedError, isPrivate } = await import("../../packages/security/src/egress.js");

describe("egress guard", () => {
  it("strict mode refuses loopback, private, link-local and metadata addresses", async () => {
    for (const url of ["http://127.0.0.1:9/x", "http://10.1.2.3/x", "http://172.16.0.1/x", "http://192.168.1.1/x", "http://169.254.169.254/latest/meta-data", "http://localhost:9/x", "http://[::1]:9/x"]) {
      await assert.rejects(() => safeFetch(url, {}, { policy: "strict" }), EgressBlockedError, url);
    }
  });

  it("strict mode refuses every spelling of a private IPv6 address, not just the canonical one", async () => {
    for (const url of [
      "http://[0:0:0:0:0:0:0:1]:9/x", // ::1, written out
      "http://[::0:1]:9/x", // ::1, folded differently
      "http://[::]:9/x", // unspecified
      "http://[::ffff:127.0.0.1]:9/x", // v4-mapped loopback
      "http://[::ffff:10.1.2.3]:9/x", // v4-mapped RFC1918
      "http://[::ffff:a01:203]:9/x", // the same address in hextets
      "http://[64:ff9b::7f00:1]:9/x", // NAT64 carrying 127.0.0.1
      "http://[64:ff9b::a9fe:a9fe]:9/x", // NAT64 carrying 169.254.169.254 (metadata)
      "http://[fe80::1]:9/x", // link-local
      "http://[FE80::1]:9/x", // case must not matter
      "http://[fec0::1]:9/x", // site-local
      "http://[fc00::1]:9/x", // unique-local
      "http://[fd12:3456::1]:9/x", // unique-local, fd half
    ]) {
      await assert.rejects(() => safeFetch(url, {}, { policy: "strict" }), EgressBlockedError, url);
    }
  });

  it("range-checks IPv6 numerically: private in every form, public untouched, unparseable refused", () => {
    for (const ip of ["::1", "0:0:0:0:0:0:0:1", "::0:1", "::", "fe80::1%eth0", "febf::1", "fec0::1", "fdff::1", "::ffff:192.168.0.1", "::ffff:c0a8:1", "64:ff9b::a00:1"]) {
      assert.equal(isPrivate(ip), true, `${ip} must be private`);
    }
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "ff02::1", "64:ff9b::808:808"]) {
      assert.equal(isPrivate(ip), false, `${ip} must not be private`);
    }
    // Anything that does not parse cleanly is refused, matching the IPv4 branch.
    assert.equal(isPrivate("not-an-ip"), true);
    assert.equal(isPrivate("1.2.3"), true);
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
