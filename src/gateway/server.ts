import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { CLOSE_NO_HELLO, CLOSE_PROTOCOL, GATEWAY_PROTOCOL, unpackEnvelope, type CloudFrame, type DeviceFrame, type FrameHeader, type HelloFrame, type ScreenshotHeader } from "../../packages/core/src/gateway.js";
import { bearer } from "../auth.js";
import { localHost } from "../browser/host-local.js";
import { acceptConnectorFrame, acceptConnectorSnapshot, connectorLiveError } from "../browser/live.js";
import type { BrowserSnapshot } from "../browser/manager.js";
import { addAudit, addCapture, getRun, setPlatformState, withOrg, type DeviceRow } from "../db.js";
import { deviceFromToken, touchDevice } from "../devices.js";
import { logger } from "../logger.js";
import { visiblePlatforms } from "../platforms.js";
import { RunTracker } from "../runs.js";
import { rejectJobsFor, settleJob } from "./calls.js";
import { registerConnector, unregisterConnector, type Connector } from "./registry.js";

export { gatewayCall, GatewayError } from "./calls.js";

const log = logger("gateway");

/*
  The cloud end of the gateway (protocol in packages/core/src/gateway.ts). A desktop
  connector authenticates at the upgrade with its device token, says hello, and from then
  on is this workspace's browser: browser ops reach it as jobs (calls.ts), and its run
  steps, platform state, captures and screenshots are written into the workspace as if the
  cloud had done the work; its screencast feeds the web live view.

  Nothing a connector sends can reach another workspace: the socket is bound to the
  device's org at hello, and every write below runs under withOrg(that org). A run id the
  connector names is looked up in that scope and ignored when it is not there.
*/

const PING_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

interface Live extends Connector {
  ws: WebSocket;
  alive: boolean;
}

/* ---------- the socket ---------- */

export async function handleGatewayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const device = await deviceFromToken(bearer(req)).catch(() => undefined);
  if (!device) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, device));
}

function onConnect(ws: WebSocket, device: DeviceRow) {
  let conn: Live | null = null;
  const helloTimer = setTimeout(() => {
    if (!conn) ws.close(CLOSE_NO_HELLO, "say hello first");
  }, HELLO_TIMEOUT_MS);
  helloTimer.unref?.();

  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN || !conn) return;
    if (!conn.alive) {
      log.info(`connector ${conn.name} (workspace ${conn.org}) stopped answering pings; cutting it`);
      ws.terminate();
      return;
    }
    conn.alive = false;
    conn.send({ t: "ping" });
  }, PING_MS);
  heartbeat.unref?.();

  ws.on("message", (data, isBinary) => {
    if (!conn) {
      if (isBinary) return ws.close(CLOSE_PROTOCOL, "hello must come first");
      const hello = parse(data.toString());
      if (!hello || hello.t !== "hello") return ws.close(CLOSE_PROTOCOL, "hello must come first");
      if (hello.protocol !== GATEWAY_PROTOCOL) return ws.close(CLOSE_PROTOCOL, `protocol ${GATEWAY_PROTOCOL} required`);
      clearTimeout(helloTimer);
      conn = makeConnector(ws, device, hello);
      registerConnector(conn);
      void welcome(conn, hello).catch((err) => log.warn("welcome failed", err));
      return;
    }
    const live = conn;
    if (isBinary) {
      handleBinary(live, data as Buffer).catch((err) => log.warn(`binary frame from ${live.name} failed`, err));
      return;
    }
    const frame = parse(data.toString());
    if (!frame) return;
    handleFrame(live, frame).catch((err) => log.warn(`frame ${frame.t} from ${live.name} failed`, err));
  });
  ws.on("close", (code, reason) => {
    clearInterval(heartbeat);
    clearTimeout(helloTimer);
    if (!conn) return;
    const gone = conn;
    conn = null;
    unregisterConnector(gone);
    rejectJobsFor(gone, "your computer disconnected before it answered");
    log.info(`connector ${gone.name} (workspace ${gone.org}) left: ${code} ${reason.toString()}`);
    void withOrg(gone.org, async () => {
      await touchDevice(gone.deviceId);
      await addAudit({ actor: `device:${gone.name}`, action: "device.disconnected", target: gone.name, detail: `${code}` });
    }).catch(() => undefined);
  });
  ws.on("error", (err) => log.warn("gateway socket error", err));
}

function parse(text: string): DeviceFrame | null {
  try {
    const v = JSON.parse(text) as DeviceFrame;
    return v && typeof v === "object" && typeof v.t === "string" ? v : null;
  } catch {
    return null;
  }
}

function makeConnector(ws: WebSocket, device: DeviceRow, hello: HelloFrame): Live {
  return {
    org: device.org_id,
    deviceId: device.id,
    name: device.name,
    app: String(hello.app ?? "").slice(0, 80),
    version: String(hello.version ?? "").slice(0, 40),
    os: String(hello.os ?? "").slice(0, 80),
    chrome: typeof hello.chrome === "string" ? hello.chrome.slice(0, 80) : null,
    providers: Array.isArray(hello.providers) ? hello.providers.filter((p): p is string => typeof p === "string").slice(0, 50) : [],
    connectedAt: new Date().toISOString(),
    ws,
    alive: true,
    send(frame: CloudFrame) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    sendBinary(buf: Buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
    },
    close(code: number, reason: string) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    },
  };
}

async function welcome(conn: Live, hello: HelloFrame) {
  await withOrg(conn.org, async () => {
    await touchDevice(conn.deviceId, { os: conn.os, app_version: conn.version });
    conn.send({ t: "welcome", protocol: GATEWAY_PROTOCOL, deviceId: conn.deviceId, org: conn.org, platforms: visiblePlatforms(), serverTime: new Date().toISOString() });
    await addAudit({ actor: `device:${conn.name}`, action: "device.connected", target: conn.name, detail: `${hello.app} ${hello.version} on ${hello.os}` });
  });
  log.info(`connector ${conn.name} (workspace ${conn.org}) is here: ${conn.app} ${conn.version} on ${conn.os}`);
}

/* ---------- frames from the connector ---------- */

/** Fields a connector may set on its own workspace's platform state. The screenshot path is the server's to set. */
const PLATFORM_PATCH_KEYS = new Set(["session_status", "last_error", "last_sync_at", "last_sync_ok", "last_checked_at"]);

/** Exported for tests: the connector object is all the frame handling knows about the socket. */
export async function handleFrame(conn: Connector, frame: DeviceFrame): Promise<void> {
  switch (frame.t) {
    case "ack":
    case "pong":
      if ("alive" in conn) (conn as Live).alive = true;
      return;
    case "result":
      settleJob(conn, frame.jobId, frame.ok, frame.value, frame.error);
      return;
    case "run-event":
      await withOrg(conn.org, async () => {
        const run = await getRun(Number(frame.runId));
        if (!run) {
          log.warn(`connector ${conn.name} reported a step for run ${frame.runId}, which is not in workspace ${conn.org}; ignored`);
          return;
        }
        await new RunTracker(run.id, run.message_id ?? null).set(String(frame.key).slice(0, 60), String(frame.label ?? "").slice(0, 200), frame.status, frame.detail == null ? null : String(frame.detail).slice(0, 2000));
      });
      return;
    case "state":
      if (frame.snapshot && typeof frame.snapshot === "object" && Array.isArray((frame.snapshot as { pages?: unknown }).pages)) acceptConnectorSnapshot(conn.org, frame.snapshot as unknown as BrowserSnapshot);
      return;
    case "platform": {
      if (typeof frame.platformId !== "string" || !frame.patch || typeof frame.patch !== "object") return;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(frame.patch)) if (PLATFORM_PATCH_KEYS.has(k)) patch[k] = v;
      if (Object.keys(patch).length) await withOrg(conn.org, () => setPlatformState(frame.platformId, patch as never));
      return;
    }
    case "capture":
      await withOrg(conn.org, () => addCapture({ platform: String(frame.platform), url: String(frame.url), method: String(frame.method), status: Number(frame.status) || 0, content_type: String(frame.content_type ?? ""), body: String(frame.body ?? "") }));
      return;
    case "audit":
      await withOrg(conn.org, () => addAudit({ actor: `device:${conn.name}`, action: String(frame.action).slice(0, 80), target: frame.target == null ? null : String(frame.target).slice(0, 200), detail: frame.detail == null ? null : String(frame.detail).slice(0, 500) }));
      return;
    case "live-error":
      connectorLiveError(conn.org, String(frame.platform), String(frame.message).slice(0, 300));
      return;
    case "hello":
      return; // one hello per socket; a second is noise
  }
}

async function handleBinary(conn: Connector, buf: Buffer): Promise<void> {
  const { header, body } = unpackEnvelope(buf);
  if (header.t === "screenshot") {
    const h = header as unknown as ScreenshotHeader;
    if (typeof h.platformId !== "string" || !body.length) return;
    await withOrg(conn.org, () => localHost.saveScreenshot(h.platformId, body));
    return;
  }
  if (header.t === "frame") {
    const h = header as unknown as FrameHeader;
    if (typeof h.platform !== "string" || !h.meta || !body.length) return;
    acceptConnectorFrame(conn.org, h.platform, h.meta, body, !!h.metaChanged);
  }
}
