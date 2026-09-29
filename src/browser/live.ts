import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { bus } from "../bus.js";
import { config } from "../config.js";
import { addAudit, withOrg } from "../db.js";
import { logger } from "../logger.js";
import { liveViewers as liveViewersGauge } from "../metrics.js";
import { browser, type BrowserSnapshot } from "./manager.js";
import { acquireStream, applyCommand, lastFrame, refreshLevel, releaseStream, LEVEL_ORDER, QUALITY, type Level, type Meta, type Sink } from "./live-stream.js";
import { LIVE_CTL_CHANNEL, LIVE_FRAME_CHANNEL } from "./live-relay.js";

/*
  The live browser view. One WebSocket per open UI (`/live`).

  Frames come from Chromium's screencast: a JPEG for every repaint, nothing when the page is
  still, sent as binary messages. Everything else is small JSON (see the protocol below).
  When this process holds the browser the frames come straight from live-stream.ts; when it
  is a bare api, they arrive over Redis from the browser worker's relay, and viewer commands
  travel the other way. The socket's owner never needs to know which.

    server → client
      { t: "state", browser }                          what tabs exist, which is in front, what the agent is doing
      { t: "meta", platform, url, title, width, height } the tab being shown and its viewport size in CSS px
      { t: "error", message }

    client → server
      { t: "watch", platform } | { t: "follow" }        show one tab, or follow whatever tab the agent uses
      { t: "quality", level: "low" | "medium" | "high" }
      { t: "mouse", kind, x, y, button } | { t: "wheel", ... } | { t: "key", ... } | { t: "text", text }
      { t: "nav", url } | { t: "back" } | { t: "forward" } | { t: "reload" }
      { t: "override", on }                              accept input while the agent is working
*/

const log = logger("live-view");

/** Frames are dropped for a client whose socket already holds this many bytes unsent. */
const MAX_BUFFERED = 1_500_000;

const localBrowser = config.role === "all" || config.role === "browser";
const remote = !localBrowser && !!config.redisUrl;

interface Client {
  ws: WebSocket;
  /** The viewer's workspace: the only tabs, frames and state they can ever see. */
  orgId: number;
  /** Explicit tab, or null while following the agent. */
  platform: string | null;
  follow: boolean;
  level: Level;
  override: boolean;
  /** The platform currently attached (local sink registered / remote want counted). */
  attached: string | null;
  sink: Sink | null;
  lastMetaKey: string | null;
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const clients = new Set<Client>();

/** The browser state as this process knows it: local snapshots, or mirrored ones from the worker. */
let snapshot: BrowserSnapshot | null = null;
bus.on("browser", (snap: BrowserSnapshot) => {
  snapshot = snap;
  for (const c of clients) {
    // Local mode recomputes per viewer so each sees exactly their workspace's tabs; the
    // mirrored remote snapshot is a founding-workspace concern until the relay carries orgs.
    sendJson(c, { t: "state", browser: currentSnapshotFor(c) });
    if (c.follow && targetOf(c) !== c.attached) void attach(c);
  }
});

export function liveViewers() {
  return clients.size;
}

export function handleLiveUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, orgId: number) {
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, orgId));
}

function sendJson(c: Client, msg: unknown) {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function currentSnapshotFor(c: Client): BrowserSnapshot {
  if (localBrowser) return withOrg(c.orgId, () => browser.snapshot());
  return snapshot ?? { seq: 0, active: null, pages: [], busy: null, signIn: null, enabled: true, running: false, headless: true };
}

function onConnect(ws: WebSocket, orgId: number) {
  const client: Client = { ws, orgId, platform: null, follow: true, level: "medium", override: false, attached: null, sink: null, lastMetaKey: null };
  clients.add(client);
  liveViewersGauge.set(clients.size);
  log.info(`live view connected (${clients.size} viewer${clients.size === 1 ? "" : "s"})`);
  sendJson(client, { t: "state", browser: currentSnapshotFor(client) });
  void attach(client);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handle(client, msg).catch((err: unknown) => log.warn("live command failed", err));
  });
  ws.on("close", () => {
    clients.delete(client);
    liveViewersGauge.set(clients.size);
    detach(client);
    log.info(`live view left (${clients.size} viewer${clients.size === 1 ? "" : "s"})`);
  });
  ws.on("error", (err) => log.warn("live socket error", err));
}

/* ---------- which tab a client sees ---------- */

function targetOf(c: Client): string | null {
  if (!c.follow && c.platform) return c.platform;
  const snap = currentSnapshotFor(c);
  return snap.active ?? snap.pages[0]?.platform ?? null;
}

function deliverTo(c: Client, frame: Buffer, meta: Meta, metaChanged: boolean) {
  if (c.ws.readyState !== c.ws.OPEN) return;
  const key = `${meta.url}|${meta.title}|${meta.width}x${meta.height}`;
  if (metaChanged || c.lastMetaKey !== key) {
    c.lastMetaKey = key;
    sendJson(c, { t: "meta", ...meta });
  }
  if (c.ws.bufferedAmount > MAX_BUFFERED) return;
  c.ws.send(frame, { binary: true });
}

async function attach(c: Client) {
  const platform = targetOf(c);
  if (c.attached === platform) return;
  detach(c);
  if (!platform) {
    sendJson(c, { t: "meta", platform: null, url: "", title: "", width: 0, height: 0 });
    return;
  }
  if (localBrowser) {
    const sink: Sink = {
      level: c.level,
      congested: () => c.ws.bufferedAmount > MAX_BUFFERED,
      deliver: (frame, meta, metaChanged) => deliverTo(c, frame, meta, metaChanged),
    };
    if (!(await acquireStream(c.orgId, platform, sink))) {
      sendJson(c, { t: "meta", platform: null, url: "", title: "", width: 0, height: 0 });
      return;
    }
    c.sink = sink;
    c.attached = platform;
    return;
  }
  // Remote: count the want; the heartbeat tells the relay, frames arrive on the shared channel.
  c.attached = platform;
  const cached = remoteLast.get(`${c.orgId}:${platform}`);
  if (cached) deliverTo(c, cached.frame, cached.meta, true);
  publishWants();
}

function detach(c: Client) {
  if (!c.attached) return;
  if (localBrowser && c.sink) releaseStream(c.orgId, c.attached, c.sink);
  c.attached = null;
  c.sink = null;
  c.lastMetaKey = null;
  if (remote) publishWants();
}

/* ---------- the remote transport (api process without a browser) ---------- */

import type { Redis } from "ioredis";
import { keepSubscribed, resilientRedis } from "../../packages/realtime/src/index.js";

const remoteLast = new Map<string, { frame: Buffer; meta: Meta }>();
let ctlPub: Redis | null = null;

function wantedNow(): { org: number; platform: string; level: Level }[] {
  const byKey = new Map<string, { org: number; platform: string; level: Level }>();
  for (const c of clients) {
    if (!c.attached) continue;
    const key = `${c.orgId}:${c.attached}`;
    const cur = byKey.get(key);
    const level = cur && LEVEL_ORDER.indexOf(cur.level) > LEVEL_ORDER.indexOf(c.level) ? cur.level : c.level;
    byKey.set(key, { org: c.orgId, platform: c.attached, level });
  }
  return [...byKey.values()];
}

function publishWants() {
  if (!ctlPub) return;
  ctlPub.publish(LIVE_CTL_CHANNEL, JSON.stringify({ t: "watching", wants: wantedNow() })).catch(() => undefined);
}

if (remote) {
  const onError = (err: unknown) => log.warn("live remote transport error", err);
  ctlPub = resilientRedis(config.redisUrl, onError);
  const frameSub = resilientRedis(config.redisUrl, onError);
  void keepSubscribed(frameSub, LIVE_FRAME_CHANNEL, onError);
  frameSub.on("message", (_ch: string, raw: string) => {
    try {
      const msg = JSON.parse(raw) as { org?: number; platform: string; meta?: Meta; metaChanged?: boolean; data?: string; error?: string };
      const org = Number(msg.org) || 1;
      if (msg.error) {
        for (const c of clients) if (c.orgId === org && c.attached === msg.platform) sendJson(c, { t: "error", message: msg.error });
        return;
      }
      if (!msg.data || !msg.meta) return;
      const frame = Buffer.from(msg.data, "base64");
      remoteLast.set(`${org}:${msg.platform}`, { frame, meta: msg.meta });
      for (const c of clients) if (c.orgId === org && c.attached === msg.platform) deliverTo(c, frame, msg.meta, !!msg.metaChanged);
    } catch (err) {
      onError(err);
    }
  });
  const beat = setInterval(publishWants, 3_000);
  beat.unref?.();
}

/* ---------- commands from the UI ---------- */

async function handle(c: Client, msg: Record<string, unknown>) {
  const t = String(msg.t ?? "");
  if (t === "watch" && typeof msg.platform === "string") {
    c.follow = false;
    c.platform = msg.platform;
    await forwardCommand(c, msg.platform, { t: "watchTab" });
    await attach(c);
    return;
  }
  if (t === "follow") {
    c.follow = true;
    c.platform = null;
    await attach(c);
    return;
  }
  if (t === "quality") {
    const level = String(msg.level) as Level;
    if (level in QUALITY) {
      c.level = level;
      if (c.sink) c.sink.level = level;
      if (localBrowser && c.attached) await refreshLevel(c.orgId, c.attached);
      if (remote) publishWants();
    }
    return;
  }
  if (t === "override") {
    c.override = !!msg.on;
    if (c.override) await withOrg(c.orgId, () => addAudit({ actor: "you", action: "browser.take_control", target: c.attached, detail: localBrowser ? (withOrg(c.orgId, () => browser.busy)?.label ?? null) : null }));
    return;
  }
  if (!c.attached) return;
  await forwardCommand(c, c.attached, msg);
}

async function forwardCommand(c: Client, platform: string, msg: Record<string, unknown>) {
  if (localBrowser) {
    const outcome = await applyCommand(c.orgId, platform, msg, { override: c.override });
    if (outcome.error) sendJson(c, { t: "error", message: outcome.error });
    return;
  }
  ctlPub?.publish(LIVE_CTL_CHANNEL, JSON.stringify({ t: "cmd", org: c.orgId, platform, override: c.override, msg })).catch(() => undefined);
}
