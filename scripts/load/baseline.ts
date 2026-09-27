/**
 * API load baseline: boots a real server (ROLE=all, SQLite by default; set TEST_PG_URL for
 * Postgres) and hammers the health and dashboard endpoints with autocannon.
 *
 *   npx tsx scripts/load/baseline.ts [seconds] [connections]
 *
 * This is the smoke that catches regressions between phases. Real capacity work (multi-
 * instance, browser fleet, provider concurrency) belongs to k6 against a deployed split
 * stack — see docs/self-hosted.md and the capacity model in the migration plan.
 */
import autocannon from "autocannon";
import { startServer } from "../../test/helpers/server.js";

const seconds = Number(process.argv[2] ?? 10);
const connections = Number(process.argv[3] ?? 25);

const server = await startServer({ BROWSER_ENABLED: "false", LOG_LEVEL: "error" });
console.log(`server up at ${server.base} — ${seconds}s x ${connections} connections per target\n`);

function run(title: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    autocannon({ url: server.base + path, connections, duration: seconds, headers }, (err, result) => {
      if (err) return reject(err);
      const r = result as unknown as { requests: { average: number }; latency: { p50: number; p97_5: number; p99: number }; errors: number; non2xx: number };
      console.log(`${title.padEnd(28)} ${String(Math.round(r.requests.average)).padStart(6)} req/s   p50 ${r.latency.p50}ms  p97.5 ${r.latency.p97_5}ms  p99 ${r.latency.p99}ms   errors ${r.errors} non2xx ${r.non2xx}`);
      resolve();
    });
  });
}

try {
  await run("GET /healthz (no auth)", "/healthz");
  await run("GET /api/home (session)", "/api/home", { cookie: server.cookie });
  await run("GET /api/runs (session)", "/api/runs?limit=20", { cookie: server.cookie });
} finally {
  await server.stop();
}
