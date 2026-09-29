import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { bus } from "../bus.js";
import { config } from "../config.js";
import { addAudit, withOrg } from "../db.js";
import { logger } from "../logger.js";
import { liveViewers as liveViewersGauge } from "../metrics.js";
import { browser, type BrowserSnapshot } from "./manager.js";
import { acquireStream, applyCommand, refreshLevel, releaseStream, LEVEL_ORDER, QUALITY, type Level, type Meta, type Sink } from "./live-stream.js";
import { LIVE_CTL_CHANNEL, LIVE_STATE_CHANNEL } from "./live-relay.js";

/*
  The live browser view. One WebSocket per open UI (`/live`).

  Frames come from Chromium's screencast: a JPEG for every repaint, nothing when the page is
  still, sent as binary messages. Everything else is small JSON (see the protocol below).
  When this process holds the browser the frames come straight from live-stream.ts; when it
  is a bare api, they arrive over Redis from the browser worker's relay — one channel per
  (workspace, tab), subscribed only while someone here is watching it — and viewer commands
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
/** Viewer sockets are pinged this often; a missed pong means a dead peer and the socket is cut. */
const PING_MS = 30_000;

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
  /** Answered the last ping. */
  alive: boolean;
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const clients = new Set<Client>();

/**
 * The browser state as this process knows it. Local mode recomputes per viewer so each sees
 * exactly their workspace's tabs. Remote mode keeps one mirrored snapshot PER WORKSPACE —
 * they arrive org-tagged over the relay's state channel — and a viewer only ever gets their
 * own workspace's; a workspace the worker has said nothing about sees an empty one.
 */
const remoteSnapshots = new Map<number, BrowserSnapshot>();
const EMPTY_SNAPSHOT: BrowserSnapshot = { seq: 0, active: null, pages: [], busy: null, signIn: null, enabled: true, running: false, headless: true };

let deliveringRemoteState = false;
bus.on("browser", (snap: BrowserSnapshot, _id?: number, org?: number) => {
  if (localBrowser) {
    for (const c of clients) {
      sendJson(c, { t: "state", browser: currentSnapshotFor(c) });
      if (c.follow && targetOf(c) !== c.attached) void attach(c);
    }
    return;
  }
  // Remote: the state channel below is the org-tagged source; its own re-emit is already
  // handled. Anything else that lands here without an org is fail-closed to the founding
  // workspace rather than shown to everyone.
  if (deliveringRemoteState) return;
  acceptRemoteSnapshot(org ?? 1, snap);
});

function acceptRemoteSnapshot(org: number, snap: BrowserSnapshot) {
  const prev = remoteSnapshots.get(org);
  if (prev && typeof snap.seq === "number" && typeof prev.seq === "number" && snap.seq < prev.seq) return;
  remoteSnapshots.set(org, snap);
  for (const c of clients) {
    if (c.orgId !== org) continue;
    sendJson(c, { t: "state", browser: snap });
    if (c.follow && targetOf(c) !== c.attached) void attach(c);
  }
}

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
  return remoteSnapshots.get(c.orgId) ?? EMPTY_SNAPSHOT;
}

function onConnect(ws: WebSocket, orgId: number) {
  const client: Client = { ws, orgId, platform: null, follow: true, level: "medium", override: false, attached: null, sink: null, lastMetaKey: null, alive: true };
  clients.add(client);
  liveViewersGauge.set(clients.size);
  log.info(`live view connected (${clients.size} viewer${clients.size === 1 ? "" : "s"})`);
  sendJson(client, { t: "state", browser: currentSnapshotFor(client) });
  void attach(client);

  // A peer that vanished without a FIN (sleeping laptop, dead NAT entry) would otherwise
  // hold its stream attachment — and its frame subscription — forever.
  ws.on("pong", () => (client.alive = true));
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!client.alive) {
      log.info("live view peer stopped answering pings; cutting it");
      ws.terminate();
      return;
    }
    client.alive = false;
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }, PING_MS);
  heartbeat.unref?.();

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
    clearInterval(heartbeat);
    clients.delete(client);
    liveViewersGauge.set(clients.size);
    detach(client);
    // The last viewer of a workspace takes its mirrored snapshot with them.
    if (remote && ![...clients].some((c) => c.orgId === client.orgId)) remoteSnapshots.delete(client.orgId);
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
  // Remote: count the want; the heartbeat tells the relay, and the stream's own frame
  // channel is subscribed for as long as anyone here watches it.
  c.attached = platform;
  retainFrames(c.orgId, platform);
  const cached = remoteLast.get(`${c.orgId}:${platform}`);
  if (cached) deliverTo(c, cached.frame, cached.meta, true);
  publishWants();
}

function detach(c: Client) {
  if (!c.attached) return;
  if (localBrowser && c.sink) releaseStream(c.orgId, c.attached, c.sink);
  if (remote) releaseFrames(c.orgId, c.attached);
  c.attached = null;
  c.sink = null;
  c.lastMetaKey = null;
  if (remote) publishWants();
}

/* ---------- the remote transport (api process without a browser) ---------- */

import type { Redis } from "ioredis";
import { liveFrameChannel, resilientRedis, unpackEnvelope } from "../../packages/realtime/src/index.js";

/** Last frame per remote stream, so a fresh viewer sees something before the next repaint. Held only while the stream has a subscription. */
const remoteLast = new Map<string, { frame: Buffer; meta: Meta }>();
/** Viewers attached per remote stream key "org:platform" — the frame-channel refcount. */
const frameWants = new Map<string, number>();
/** Channels this process wants subscribed; re-asserted after every reconnect. */
const desiredChannels = new Set<string>();
let ctlPub: Redis | null = null;
let remoteSub: Redis | null = null;

function subscribeNow(channels: string[]) {
  if (remoteSub && remoteSub.status === "ready" && channels.length) remoteSub.subscribe(...channels).catch(() => undefined);
}

function retainFrames(org: number, platform: string) {
  const key = `${org}:${platform}`;
  const n = (frameWants.get(key) ?? 0) + 1;
  frameWants.set(key, n);
  if (n === 1) {
    const ch = liveFrameChannel(org, platform);
    desiredChannels.add(ch);
    subscribeNow([ch]);
  }
}

function releaseFrames(org: number, platform: string) {
  const key = `${org}:${platform}`;
  const n = (frameWants.get(key) ?? 0) - 1;
  if (n > 0) {
    frameWants.set(key, n);
    return;
  }
  frameWants.delete(key);
  const ch = liveFrameChannel(org, platform);
  desiredChannels.delete(ch);
  remoteSub?.unsubscribe(ch).catch(() => undefined);
  // The cached frame goes with the subscription: nothing keeps stale tabs in heap.
  remoteLast.delete(key);
}

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
  const sub = resilientRedis(config.redisUrl, onError);
  remoteSub = sub;
  desiredChannels.add(LIVE_STATE_CHANNEL);
  sub.on("ready", () => subscribeNow([...desiredChannels]));
  subscribeNow([...desiredChannels]);

  // One buffer-mode handler for both kinds of message: the state channel carries small
  // JSON, a frame channel carries a header line plus the raw JPEG bytes.
  sub.on("messageBuffer", (channel: Buffer, raw: Buffer) => {
    try {
      const ch = channel.toString();
      if (ch === LIVE_STATE_CHANNEL) {
        const { org, snap } = JSON.parse(raw.toString()) as { org?: number; snap?: BrowserSnapshot };
        if (!snap) return;
        const orgId = Number(org) || 1;
        acceptRemoteSnapshot(orgId, snap);
        // Re-announce on the local bus, org and all, so the SSE stream delivers the
        // snapshot to that workspace's dashboards too. The flag stops our own handler
        // above from treating the echo as a second, org-less source.
        deliveringRemoteState = true;
        try {
          bus.emit("browser", snap, undefined, orgId);
        } finally {
          deliveringRemoteState = false;
        }
        return;
      }
      const { header, body } = unpackEnvelope(raw);
      const platform = String(header.platform ?? "");
      const org = Number(header.org) || 1;
      if (!platform) return;
      if (typeof header.error === "string") {
        for (const c of clients) if (c.orgId === org && c.attached === platform) sendJson(c, { t: "error", message: header.error });
        return;
      }
      const meta = header.meta as Meta | undefined;
      if (!body.length || !meta) return;
      const key = `${org}:${platform}`;
      if (frameWants.has(key)) remoteLast.set(key, { frame: body, meta });
      for (const c of clients) if (c.orgId === org && c.attached === platform) deliverTo(c, body, meta, !!header.metaChanged);
    } catch (err) {
      onError(err);
    }
  });

  const beat = setInterval(publishWants, 3_000);
  beat.unref?.();

  // Belt and braces: a cached frame whose subscription is gone (an unsubscribe raced an
  // in-flight message) must not sit in heap forever.
  const sweep = setInterval(() => {
    for (const key of remoteLast.keys()) if (!frameWants.has(key)) remoteLast.delete(key);
  }, 15_000);
  sweep.unref?.();
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
