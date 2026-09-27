import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { bus } from "../bus.js";
import { config } from "../config.js";
import { addAudit } from "../db.js";
import { logger } from "../logger.js";
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
    sendJson(c, { t: "state", browser: snap });
    if (c.follow && targetOf(c) !== c.attached) void attach(c);
  }
});

export function liveViewers() {
  return clients.size;
}

export function handleLiveUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws));
}

function sendJson(c: Client, msg: unknown) {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function currentSnapshot(): BrowserSnapshot {
  if (localBrowser) return browser.snapshot();
  return snapshot ?? { seq: 0, active: null, pages: [], busy: null, signIn: null, enabled: true, running: false, headless: true };
}

function onConnect(ws: WebSocket) {
  const client: Client = { ws, platform: null, follow: true, level: "medium", override: false, attached: null, sink: null, lastMetaKey: null };
  clients.add(client);
  log.info(`live view connected (${clients.size} viewer${clients.size === 1 ? "" : "s"})`);
  sendJson(client, { t: "state", browser: currentSnapshot() });
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
    detach(client);
    log.info(`live view left (${clients.size} viewer${clients.size === 1 ? "" : "s"})`);
  });
  ws.on("error", (err) => log.warn("live socket error", err));
}

/* ---------- which tab a client sees ---------- */

function targetOf(c: Client): string | null {
  if (!c.follow && c.platform) return c.platform;
  const snap = currentSnapshot();
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
    if (!(await acquireStream(platform, sink))) {
      sendJson(c, { t: "meta", platform: null, url: "", title: "", width: 0, height: 0 });
      return;
    }
    c.sink = sink;
    c.attached = platform;
    return;
  }
  // Remote: count the want; the heartbeat tells the relay, frames arrive on the shared channel.
  c.attached = platform;
  const cached = remoteLast.get(platform);
  if (cached) deliverTo(c, cached.frame, cached.meta, true);
  publishWants();
}

function detach(c: Client) {
  if (!c.attached) return;
  if (localBrowser && c.sink) releaseStream(c.attached, c.sink);
  c.attached = null;
  c.sink = null;
  c.lastMetaKey = null;
  if (remote) publishWants();
}

/* ---------- the remote transport (api process without a browser) ---------- */

import { Redis } from "ioredis";

const remoteLast = new Map<string, { frame: Buffer; meta: Meta }>();
let ctlPub: Redis | null = null;

function wantedNow(): { platform: string; level: Level }[] {
  const byPlatform = new Map<string, Level>();
  for (const c of clients) {
    if (!c.attached) continue;
    const cur = byPlatform.get(c.attached) ?? "low";
    byPlatform.set(c.attached, LEVEL_ORDER.indexOf(c.level) > LEVEL_ORDER.indexOf(cur) ? c.level : cur);
  }
  return [...byPlatform.entries()].map(([platform, level]) => ({ platform, level }));
}

function publishWants() {
  if (!ctlPub) return;
  ctlPub.publish(LIVE_CTL_CHANNEL, JSON.stringify({ t: "watching", wants: wantedNow() })).catch(() => undefined);
}

if (remote) {
  const onError = (err: unknown) => log.warn("live remote transport error", err);
  ctlPub = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  ctlPub.on("error", onError);
  const frameSub = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  frameSub.on("error", onError);
  void (async () => {
    await ctlPub!.connect();
    await frameSub.connect();
    await frameSub.subscribe(LIVE_FRAME_CHANNEL);
    frameSub.on("message", (_ch: string, raw: string) => {
      try {
        const msg = JSON.parse(raw) as { platform: string; meta?: Meta; metaChanged?: boolean; data?: string; error?: string };
        if (msg.error) {
          for (const c of clients) if (c.attached === msg.platform) sendJson(c, { t: "error", message: msg.error });
          return;
        }
        if (!msg.data || !msg.meta) return;
        const frame = Buffer.from(msg.data, "base64");
        remoteLast.set(msg.platform, { frame, meta: msg.meta });
        for (const c of clients) if (c.attached === msg.platform) deliverTo(c, frame, msg.meta, !!msg.metaChanged);
      } catch (err) {
        onError(err);
      }
    });
    const beat = setInterval(publishWants, 3_000);
    beat.unref?.();
  })().catch(onError);
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
      if (localBrowser && c.attached) await refreshLevel(c.attached);
      if (remote) publishWants();
    }
    return;
  }
  if (t === "override") {
    c.override = !!msg.on;
    if (c.override) await addAudit({ actor: "you", action: "browser.take_control", target: c.attached, detail: localBrowser ? (browser.busy?.label ?? null) : null });
    return;
  }
  if (!c.attached) return;
  await forwardCommand(c, c.attached, msg);
}

async function forwardCommand(c: Client, platform: string, msg: Record<string, unknown>) {
  if (localBrowser) {
    const outcome = await applyCommand(platform, msg, { override: c.override });
    if (outcome.error) sendJson(c, { t: "error", message: outcome.error });
    return;
  }
  ctlPub?.publish(LIVE_CTL_CHANNEL, JSON.stringify({ t: "cmd", platform, override: c.override, msg })).catch(() => undefined);
}
