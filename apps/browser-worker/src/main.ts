import http from "node:http";
import { startRedisBridge } from "../../../packages/realtime/src/index.js";
import { startLiveRelay } from "../../../src/browser/live-relay.js";
import { settleCommandMessage } from "../../../src/answers.js";
import { bus } from "../../../src/bus.js";
import { browser } from "../../../src/browser/manager.js";
import { config } from "../../../src/config.js";
import { dbReady } from "../../../src/db.js";
import { logger } from "../../../src/logger.js";
import { saveToDatabase, stopPersistLoop } from "../../../src/persist.js";
import { initPlatforms } from "../../../src/platforms.js";
import { scheduleCrons } from "../../../src/jobs.js";
import { queue } from "../../../src/queue.js";
import { onRunEnded } from "../../../src/runs.js";
import { startExecutionServices } from "../../../src/services.js";
import { stopScheduler } from "../../../src/sync.js";

const log = logger("browser-worker");

/*
  The worker process: claims jobs from the shared queue and runs everything long-lived —
  deliveries, task starts, resumes, schedulers, pollers, sweepers, and (until the browser
  fleet splits) the browser. No API here beyond health probes.
*/

onRunEnded(settleCommandMessage);

await initPlatforms();
if (config.redisUrl) {
  await startRedisBridge(bus, config.redisUrl, { onError: (err) => log.warn("redis bridge error", err) });
  log.info("redis event bridge up");
  await startLiveRelay(config.redisUrl);
}
await startExecutionServices("browser");
await queue.start();
await scheduleCrons("browser");
log.info(`browser worker up (queue: ${queue.kind}, data: ${config.dataDir})`);

// Health probes for the orchestrator: liveness = process; readiness = database reachable.
const health = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, role: "browser" }));
    return;
  }
  if (req.url === "/readyz") {
    try {
      await dbReady();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  res.writeHead(404).end();
});
health.listen(config.port, () => log.info(`browser worker health on :${config.port}`));

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  stopScheduler();
  stopPersistLoop();
  health.close();
  // Stop claiming, finish what fits in the grace budget, close the browser, final save.
  await Promise.race([queue.stop(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 6_000))]);
  await Promise.race([saveToDatabase(true), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));
