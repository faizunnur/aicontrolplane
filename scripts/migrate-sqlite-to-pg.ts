/**
 * One-time cutover: copy every row from the SQLite file into Postgres.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate-sqlite-to-pg.ts [path/to/acp.sqlite]
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate-sqlite-to-pg.ts --from-mirror
 *
 * --from-mirror reads the SQLite file (and platforms.json) from the acp_files table that the
 * old whole-file mirror kept in that same Postgres — the path for a Railway deployment that
 * used DATABASE_URL as its backup before Postgres became the database.
 *
 * Idempotent by design: the target tables are emptied first, so the script can be rehearsed
 * as often as needed. Run it with the server stopped; ids are preserved and the sequences
 * advanced past them. The circular runs<->messages references are handled by copying
 * messages without their run_id first and patching it once runs exist.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const fromMirror = process.argv.includes("--from-mirror");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// FK-safe copy order. messages is copied before runs (with run_id deferred, see below);
// users before sessions (sessions.user_id). Tables missing from an older file are skipped.
const TABLES = ["agent_profiles", "conversations", "tasks", "messages", "runs", "run_events", "events", "platform_state", "captures", "sync_log", "settings", "policies", "approvals", "audit_log", "users", "sessions", "pairings", "browser_sessions"];
const DEFER: Record<string, string[]> = { messages: ["run_id"] };

const dst = new pg.Pool({ connectionString: url, max: 2, ssl: (process.env.ACP_PG_SSL || "").toLowerCase() === "no-verify" ? { rejectUnauthorized: false } : undefined });

/** Pull the mirrored files out of acp_files into a temp folder; returns the SQLite path. */
async function extractMirror(): Promise<{ sqlitePath: string; platformsJson: string | null }> {
  const has = await dst.query("SELECT to_regclass('acp_files') AS t");
  if (!has.rows[0]?.t) throw new Error("no acp_files table in this database: nothing was ever mirrored here");
  const rows = (await dst.query<{ name: string; data: Buffer }>("SELECT name, data FROM acp_files")).rows;
  const db = rows.find((r) => r.name === "acp.sqlite");
  if (!db) throw new Error("acp_files holds no acp.sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-mirror-"));
  const sqlitePath = path.join(dir, "acp.sqlite");
  fs.writeFileSync(sqlitePath, db.data);
  const platforms = rows.find((r) => r.name === "platforms.json");
  console.log(`extracted acp.sqlite (${db.data.length} bytes) from the mirror table`);
  return { sqlitePath, platformsJson: platforms ? platforms.data.toString("utf8") : null };
}

let sqlitePath = process.argv.slice(2).find((a) => !a.startsWith("--")) || path.join(process.env.DATA_DIR || "./data", "acp.sqlite");
let platformsJson: string | null = null;

async function main() {
  if (fromMirror) ({ sqlitePath, platformsJson } = await extractMirror());
  const src = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  // The app's own init applies the Postgres baseline; do the same here so the script stands alone.
  const { openPg } = await import("../packages/data/src/pg.js");
  const opened = await openPg(url!);
  await opened.driver.close();

  const client = await dst.connect();
  try {
    await client.query("BEGIN");
    for (const t of [...TABLES].reverse()) await client.query(`DELETE FROM ${t}`);

    let total = 0;
    for (const table of TABLES) {
      const exists = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      if (!exists) {
        console.log(`  ${table}: not in the SQLite file, skipped`);
        continue;
      }
      const srcCols = (src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      const dstCols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [table])).rows.map((r: { column_name: string }) => r.column_name);
      const deferred = DEFER[table] ?? [];
      const cols = srcCols.filter((c) => dstCols.includes(c) && !deferred.includes(c));
      const rows = src.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const values: unknown[] = [];
        const tuples = chunk
          .map((row) => `(${cols.map((c) => (values.push(row[c] ?? null), `$${values.length}`)).join(",")})`)
          .join(",");
        await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples}`, values);
      }
      const seq = dstCols.includes("id") ? (await client.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [table])).rows[0]?.s : null;
      if (seq) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), 1))`);
      }
      total += rows.length;
      console.log(`  ${table}: ${rows.length} rows`);
    }

    // Patch the deferred circular reference now that runs exist.
    const withRun = src.prepare("SELECT id, run_id FROM messages WHERE run_id IS NOT NULL").all() as { id: number; run_id: number }[];
    for (const m of withRun) await client.query("UPDATE messages SET run_id = $1 WHERE id = $2", [m.run_id, m.id]);
    if (withRun.length) console.log(`  messages.run_id: ${withRun.length} back-references patched`);

    // A file from before user accounts carries the password only as a settings row. Without an
    // owner the app would offer "create your password" to whoever opens it first — so derive
    // the owner here exactly as the Postgres users migration does.
    const users = Number((await client.query("SELECT COUNT(*) AS n FROM users")).rows[0].n);
    const legacy = (await client.query<{ value: string }>("SELECT value FROM settings WHERE key = 'admin_password_hash'")).rows[0];
    if (users === 0 && legacy) {
      const ts = new Date().toISOString();
      await client.query("INSERT INTO users (email, password_hash, role, created_at, updated_at) VALUES ($1, $2, 'owner', $3, $3)", ["admin@local", `sha256:${legacy.value}`, ts]);
      console.log("  users: owner created from the existing password (sign in with it; no email needed)");
    }
    if (platformsJson !== null) {
      await client.query("INSERT INTO settings (key, value) VALUES ('platform_overrides', $1) ON CONFLICT (key) DO NOTHING", [platformsJson]);
      console.log("  settings: provider overrides imported from the mirrored platforms.json");
    }

    await client.query("COMMIT");
    console.log(`done: ${total} rows copied from ${sqlitePath}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await dst.end();
    src.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
