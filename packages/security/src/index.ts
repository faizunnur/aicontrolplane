import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
  Envelope encryption for secrets at rest (provider cookies, session state, tokens):

    plaintext --AES-256-GCM--> ciphertext, under a fresh data key (DEK) per record
    DEK       --AES-256-GCM--> wrapped DEK, under the keystore's key-encryption key

  The keystore is the pluggable part: the baseline wraps under a master key from the
  ACP_MASTER_KEY environment variable (or a generated key file in the data folder, so
  self-hosted installs work out of the box); a cloud KMS backend slots in behind the same
  interface later. Rotation re-wraps DEKs without touching the sealed payloads.
*/

export interface Keystore {
  /** Identifies which key wrapped a DEK, so rotation can tell old from new. */
  readonly keyId: string;
  wrapDek(dek: Buffer): Promise<string>;
  unwrapDek(wrapped: string, keyId: string): Promise<Buffer>;
}

const PREFIX = "enc1:";

interface SealedV1 {
  v: 1;
  kid: string;
  dek: string; // wrapped
  iv: string;
  tag: string;
  ct: string;
}

export class Envelope {
  constructor(private readonly keystore: Keystore) {}

  async seal(plaintext: string): Promise<string> {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const sealed: SealedV1 = {
      v: 1,
      kid: this.keystore.keyId,
      dek: await this.keystore.wrapDek(dek),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
    return PREFIX + Buffer.from(JSON.stringify(sealed)).toString("base64");
  }

  async open(sealed: string): Promise<string> {
    if (!isSealed(sealed)) throw new Error("not a sealed payload");
    const parsed = JSON.parse(Buffer.from(sealed.slice(PREFIX.length), "base64").toString("utf8")) as SealedV1;
    if (parsed.v !== 1) throw new Error(`unknown sealed payload version ${parsed.v}`);
    const dek = await this.keystore.unwrapDek(parsed.dek, parsed.kid);
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64")), decipher.final()]).toString("utf8");
  }
}

export function isSealed(s: string): boolean {
  return s.startsWith(PREFIX);
}

/** The baseline keystore: wraps DEKs under a 32-byte master key held in memory. */
export class EnvKeystore implements Keystore {
  readonly keyId: string;
  constructor(private readonly master: Buffer) {
    if (master.length !== 32) throw new Error("master key must be 32 bytes");
    this.keyId = "env:" + createHash("sha256").update(master).digest("hex").slice(0, 8);
  }
  async wrapDek(dek: Buffer): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  }
  async unwrapDek(wrapped: string): Promise<Buffer> {
    const raw = Buffer.from(wrapped, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.master, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }
}

/** Accepts hex (64 chars), base64 (44 chars), or any passphrase (hashed to 32 bytes). */
export function parseMasterKey(raw: string): Buffer {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    if (b.length === 32) return b;
  } catch {
    /* not base64 */
  }
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * The master key for this deployment: ACP_MASTER_KEY when set (recommended - keep it in your
 * secret manager), otherwise a key file in the data folder, generated on first use so
 * self-hosted installs encrypt out of the box. The file next to the data it protects guards
 * against database leaks, not against whoever holds the volume; set the env var for that.
 */
export function loadMasterKey(dataDir: string, warn: (msg: string) => void = console.warn): Buffer {
  const fromEnv = process.env.ACP_MASTER_KEY;
  if (fromEnv) return parseMasterKey(fromEnv);
  const file = path.join(dataDir, "master.key");
  if (fs.existsSync(file)) return parseMasterKey(fs.readFileSync(file, "utf8"));
  const key = randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  warn(`generated an encryption master key at ${file}; set ACP_MASTER_KEY (same value) in your secrets to move it out of the data folder`);
  return key;
}
