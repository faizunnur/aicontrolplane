/**
 * One-time cutover: copy every row from the SQLite file into Postgres.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate-sqlite-to-pg.ts [path/to/acp.sqlite]
 *
 * Idempotent by design: the target tables are emptied first, so the script can be rehearsed
 * as often as needed. Run it with the server stopped; ids are preserved and the sequences
 * advanced past them. The circular runs<->messages references are handled by copying
 * messages without their run_id first and patching it once runs exist.
 */
import Database from "better-sqlite3";
import path from "node:path";
import pg from "pg";

const sqlitePath = process.argv[2] || path.join(process.env.DATA_DIR || "./data", "acp.sqlite");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// FK-safe copy order. messages is copied before runs (with run_id deferred, see below).
const TABLES = ["agent_profiles", "conversations", "tasks", "messages", "runs", "run_events", "events", "platform_state", "captures", "sync_log", "settings", "policies", "approvals", "audit_log", "sessions", "pairings"];
const DEFER: Record<string, string[]> = { messages: ["run_id"] };

const src = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const dst = new pg.Pool({ connectionString: url, max: 2, ssl: (process.env.ACP_PG_SSL || "").toLowerCase() === "no-verify" ? { rejectUnauthorized: false } : undefined });

async function main() {
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
      if (dstCols.includes("id")) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), 1))`);
      }
      total += rows.length;
      console.log(`  ${table}: ${rows.length} rows`);
    }

    // Patch the deferred circular reference now that runs exist.
    const withRun = src.prepare("SELECT id, run_id FROM messages WHERE run_id IS NOT NULL").all() as { id: number; run_id: number }[];
    for (const m of withRun) await client.query("UPDATE messages SET run_id = $1 WHERE id = $2", [m.run_id, m.id]);
    if (withRun.length) console.log(`  messages.run_id: ${withRun.length} back-references patched`);

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
