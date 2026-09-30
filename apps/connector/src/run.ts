import http from "node:http";
import os from "node:os";
import { ConnectorClient } from "../../../packages/connector/src/client.js";
import { GatewayHost } from "../../../packages/connector/src/host.js";
import { runOp } from "../../../packages/connector/src/ops.js";
import { packEnvelope } from "../../../packages/core/src/gateway.js";
import { withOrg } from "../../../packages/core/src/scope.js";
import { bus } from "../../../src/bus.js";
import { setHost } from "../../../src/browser/host.js";
import { acquireStream, applyCommand, refreshLevel, releaseStream, type Sink } from "../../../src/browser/live-stream.js";
import { browser, resolveExecutable, type BrowserSnapshot } from "../../../src/browser/manager.js";
import { config } from "../../../src/config.js";
import { logger } from "../../../src/logger.js";

const log = logger("connector");

/*
  One workspace, one browser, one socket. Jobs from the cloud run the browser flows here
  with the gateway host installed (every write becomes a frame); the browser's snapshot and
  any watched tab's screencast go up; viewer commands come down.
*/

/** Frames are dropped for the cloud while the socket already holds this many bytes unsent. */
const MAX_BUFFERED = 1_500_000;

const exe = resolveExecutable();
let org = 1;
const sinks = new Map<string, Sink>();

const client: ConnectorClient = new ConnectorClient({
  url: process.env.ACP_URL!,
  token: process.env.ACP_DEVICE_TOKEN!,
  hello: {
    app: "acp-connector",
    version: process.env.npm_package_version || "dev",
    os: `${os.platform()} ${os.release()}`,
    chrome: `${exe.source}: ${exe.path}`,
    providers: [],
  },
  log: (message, err) => (err ? log.warn(message, err) : log.info(message)),
  onState: (state, detail) => log.info(`gateway ${state}${detail ? `: ${detail}` : ""}`),
  onWelcome: async (welcome) => {
    org = welcome.org;
    host.setPlatforms(welcome.platforms);
    log.info(`welcome from workspace ${org} as device #${welcome.deviceId}: ${welcome.platforms.length} providers`);
    client.send({ t: "state", snapshot: browser.snapshot() as unknown as Record<string, unknown> });
  },
  onJob: (job): Promise<unknown> => withOrg(org, () => runOp(job.op, job.payload, host, job.platform)),
  onLive: async (want) => {
    const key = want.platform;
    if (want.level === null) {
      const s = sinks.get(key);
      if (s) releaseStream(org, key, s);
      sinks.delete(key);
      return;
    }
    const existing = sinks.get(key);
    if (existing) {
      existing.level = want.level;
      await refreshLevel(org, key);
      return;
    }
    const sink: Sink = {
      level: want.level,
      congested: () => client.bufferedAmount > MAX_BUFFERED,
      deliver: (frame, meta, metaChanged) => {
        client.sendBinary(packEnvelope({ t: "frame", platform: key, meta, metaChanged }, frame));
      },
    };
    if (!(await withOrg(org, () => acquireStream(org, key, sink)))) {
      client.send({ t: "live-error", platform: key, message: "that tab is not open on this computer" });
      return;
    }
    sinks.set(key, sink);
  },
  onCmd: async (cmd) => {
    const outcome = await applyCommand(org, cmd.platform, cmd.msg, { override: cmd.override, actor: "you" });
    if (outcome.error) client.send({ t: "live-error", platform: cmd.platform, message: outcome.error });
  },
  onCancel: (runId) => host.cancelled.add(runId),
});

const host: GatewayHost = new GatewayHost(client, config.dataDir);
setHost(host);

// Every change to the browser (a tab opened, a task started, a sign-in) goes up as the workspace's state.
bus.on("browser", (snap: BrowserSnapshot) => {
  client.send({ t: "state", snapshot: snap as unknown as Record<string, unknown> });
});

log.info(`connector starting: ${process.env.ACP_URL}, data in ${config.dataDir}, browser ${exe.source} (${exe.path}), headless=${config.browser.headless}`);
client.start();

// A local health probe for the desktop shell or a test harness; only when asked for.
const port = Number(process.env.PORT) || 0;
const health = port
  ? http
      .createServer((req, res) => {
        if (req.url === "/healthz") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, role: "connector", connected: client.connected, org: client.welcome?.org ?? null }));
          return;
        }
        res.writeHead(404).end();
      })
      .listen(port, "127.0.0.1", () => log.info(`connector health on 127.0.0.1:${port}`))
  : null;

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  client.stop();
  health?.close();
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 6_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));
