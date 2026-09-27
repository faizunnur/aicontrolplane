import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { testDataDir } from "../helpers/env.js";

const { Envelope, EnvKeystore, isSealed, loadMasterKey, parseMasterKey } = await import("../../packages/security/src/index.js");

describe("envelope encryption", () => {
  const envelope = new Envelope(new EnvKeystore(parseMasterKey("a".repeat(64))));

  it("seals and opens a payload, with a fresh data key per record", async () => {
    const a = await envelope.seal("cookie-jar-contents");
    const b = await envelope.seal("cookie-jar-contents");
    assert.ok(isSealed(a));
    assert.notEqual(a, b, "same plaintext never seals to the same bytes");
    assert.equal(await envelope.open(a), "cookie-jar-contents");
    assert.equal(await envelope.open(b), "cookie-jar-contents");
  });

  it("refuses a tampered payload and a wrong key", async () => {
    const sealed = await envelope.seal("secret");
    const bytes = Buffer.from(sealed.slice("enc1:".length), "base64").toString("utf8");
    const tampered = "enc1:" + Buffer.from(bytes.replace(/"ct":"..../, (m) => m.slice(0, -1) + (m.endsWith("A") ? "B" : "A"))).toString("base64");
    await assert.rejects(() => envelope.open(tampered));
    const other = new Envelope(new EnvKeystore(parseMasterKey("b".repeat(64))));
    await assert.rejects(() => other.open(sealed));
    await assert.rejects(() => envelope.open("plaintext"));
  });

  it("accepts hex, base64 and passphrase master keys", () => {
    assert.equal(parseMasterKey("ab".repeat(32)).length, 32);
    assert.equal(parseMasterKey(Buffer.alloc(32, 7).toString("base64")).length, 32);
    assert.equal(parseMasterKey("correct horse battery staple").length, 32);
  });

  it("generates a key file once when no ACP_MASTER_KEY is set", () => {
    const dir = path.join(testDataDir, "keys");
    delete process.env.ACP_MASTER_KEY;
    const warnings: string[] = [];
    const k1 = loadMasterKey(dir, (m) => warnings.push(m));
    const k2 = loadMasterKey(dir, (m) => warnings.push(m));
    assert.deepEqual(k1, k2, "the generated key is stable");
    assert.equal(warnings.length, 1, "warned once, on generation");
    assert.ok(fs.existsSync(path.join(dir, "master.key")));
  });
});
