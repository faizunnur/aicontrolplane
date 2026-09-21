import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

const log = logger("persist");

/*
  Persistence without a volume. When DATABASE_URL (Railway Postgres) is set, the three
  small files that hold everything the user cares about are mirrored into one table:

    acp.sqlite      chat history, tasks, runs, password, settings   (consistent snapshot)
    platforms.json  the AIs you added and their settings
    sessions.json   your sign-ins (cookies), also restored into the browser profile on boot

  On boot, missing local files are restored from the table before the database is opened.
  Afterwards a loop uploads whichever file changed, and shutdown does a final save.
  Screenshots are not mirrored; they are regenerated on the next look.
*/

const url = process.env.DATABASE_URL || process.env.PERSIST_DATABASE_URL || "";
export const persistEnabled = !!url;
const FILES = ["acp.sqlite", "platforms.json", "sessions.json"] as const;

let pool: pg.Pool | null = null;
let ready: Promise<boolean> | null = null;
const lastHash = new Map<string, string>();
let lastSaveAt: string | null = null;
let lastError: string | null = null;
let saving: Promise<string[]> | null = null;

function connect(): Promise<boolean> {
  if (!persistEnabled) return Promise.resolve(false);
  if (ready) return ready;
  ready = (async () => {
    try {
      pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000, ssl: /sslmode=require|railway|\.rlwy\.net/.test(url) && !/localhost|127\.0\.0\.1|host\.docker\.internal/.test(url) ? { rejectUnauthorized: false } : undefined });
      await pool.query(`CREATE TABLE IF NOT EXISTS acp_files (name TEXT PRIMARY KEY, data BYTEA NOT NULL, sha256 TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      lastError = null;
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error(`cannot use DATABASE_URL for persistence: ${lastError}`);
      pool = null;
      return false;
    }
  })();
  return ready;
}

/** Called by bootstrap before the SQLite database is opened. Returns the files that were restored. */
export async function restoreFromDatabase(): Promise<string[]> {
  if (!(await connect()) || !pool) return [];
  const restored: string[] = [];
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const name of FILES) {
    const local = path.join(config.dataDir, name);
    if (fs.existsSync(local)) continue;
    try {
      const r = await pool.query<{ data: Buffer; sha256: string }>("SELECT data, sha256 FROM acp_files WHERE name = $1", [name]);
      if (!r.rows.length) continue;
      fs.writeFileSync(local, r.rows[0].data);
      lastHash.set(name, r.rows[0].sha256);
      restored.push(name);
    } catch (err) {
      log.warn(`restore of ${name} failed`, err);
    }
  }
  if (restored.length) log.info(`restored from database: ${restored.join(", ")}`);
  else log.info("database persistence on; nothing to restore");
  return restored;
}

/** Upload any file that changed since the last upload. Safe to call often. */
export async function saveToDatabase(force = false): Promise<string[]> {
  if (!persistEnabled) return [];
  if (saving) return saving;
  saving = (async () => {
    if (!(await connect()) || !pool) return [];
    const saved: string[] = [];
    for (const name of FILES) {
      try {
        const buf = await snapshot(name);
        if (!buf) continue;
        const sha = createHash("sha256").update(buf).digest("hex");
        if (!force && lastHash.get(name) === sha) continue;
        await pool.query(
          `INSERT INTO acp_files (name, data, sha256, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, sha256 = EXCLUDED.sha256, updated_at = now()`,
          [name, buf, sha],
        );
        lastHash.set(name, sha);
        saved.push(name);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn(`save of ${name} failed: ${lastError}`);
      }
    }
    if (saved.length) {
      lastSaveAt = new Date().toISOString();
      lastError = null;
      log.info(`saved to database: ${saved.join(", ")}`);
    }
    return saved;
  })().finally(() => (saving = null));
  return saving;
}

/** A consistent copy of a file. SQLite goes through its online-backup API so WAL contents are included. */
async function snapshot(name: string): Promise<Buffer | null> {
  const local = path.join(config.dataDir, name);
  if (!fs.existsSync(local)) return null;
  if (name !== "acp.sqlite") return fs.readFileSync(local);
  const { db } = await import("./db.js");
  const tmp = path.join(config.dataDir, `.snapshot-${process.pid}.sqlite`);
  try {
    await db.backup(tmp);
    return fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

let timer: NodeJS.Timeout | null = null;
export function startPersistLoop(intervalMs = 60_000) {
  if (!persistEnabled) return;
  const tick = () => void saveToDatabase().catch(() => undefined);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 15_000).unref?.();
  log.info(`database persistence armed (every ${Math.round(intervalMs / 1000)}s)`);
}
export function stopPersistLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
export function persistStatus() {
  return { enabled: persistEnabled, lastSaveAt, lastError };
}
