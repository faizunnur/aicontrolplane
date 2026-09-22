import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { CDPSession, Page } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";
import { bus } from "../bus.js";
import { logger } from "../logger.js";
import { browser, type BrowserSnapshot } from "./manager.js";

/*
  The live browser view. One WebSocket per open UI (`/live`).

  Frames come straight from Chromium's screencast (Page.startScreencast over CDP): a JPEG
  for every repaint of the tab, nothing when the page is still. They are sent as binary
  messages. Everything else is small JSON:

    server → client
      { t: "state", browser }                          what tabs exist, which is in front, what the agent is doing
      { t: "meta", platform, url, title, width, height } the tab being shown and its viewport size in CSS px
      { t: "error", message }

    client → server
      { t: "watch", platform } | { t: "follow" }        show one tab, or follow whatever tab the agent uses
      { t: "quality", level: "low" | "medium" | "high" }
      { t: "mouse", kind: "move" | "down" | "up", x, y, button }    x, y are 0..1 of the frame
      { t: "wheel", x, y, dx, dy }
      { t: "key", kind: "down" | "up", key }            DOM KeyboardEvent.key
      { t: "text", text }                                paste / IME
      { t: "nav", url } | { t: "back" } | { t: "forward" } | { t: "reload" }
      { t: "override", on }                              accept input while the agent is working

  While the agent holds the browser lock the view is read-only unless the client overrides,
  so a stray click cannot break a task that is typing.
*/

const log = logger("live-view");

const QUALITY = {
  low: { quality: 35, maxWidth: 960, maxHeight: 640 },
  medium: { quality: 55, maxWidth: 1280, maxHeight: 900 },
  high: { quality: 75, maxWidth: 1680, maxHeight: 1100 },
} as const;
type Level = keyof typeof QUALITY;
const LEVEL_ORDER: Level[] = ["low", "medium", "high"];

/** Frames are dropped for a client whose socket already holds this many bytes unsent. */
const MAX_BUFFERED = 1_500_000;

interface Client {
  ws: WebSocket;
  /** Explicit tab, or null while following the agent. */
  platform: string | null;
  follow: boolean;
  level: Level;
  override: boolean;
  stream: Stream | null;
}

interface Meta {
  platform: string;
  url: string;
  title: string;
  width: number;
  height: number;
}

interface Stream {
  platform: string;
  page: Page;
  session: CDPSession;
  watchers: Set<Client>;
  level: Level;
  last: Buffer | null;
  meta: Meta | null;
  stopTimer: NodeJS.Timeout | null;
  frames: number;
  started: boolean;
  /** Page listeners to remove when the stream stops. */
  off: () => void;
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const clients = new Set<Client>();
const streams = new Map<string, Stream>();

export function liveViewers() {
  return clients.size;
}

export function handleLiveUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws));
}

function sendJson(c: Client, msg: unknown) {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function onConnect(ws: WebSocket) {
  const client: Client = { ws, platform: null, follow: true, level: "medium", override: false, stream: null };
  clients.add(client);
  sendJson(client, { t: "state", browser: browser.snapshot() });
  void attach(client);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handle(client, msg).catch((err) => log.warn("live command failed", err));
  });
  ws.on("close", () => {
    clients.delete(client);
    detach(client);
  });
  ws.on("error", (err) => log.warn("live socket error", err));
}

/* ---------- which tab a client sees ---------- */

function targetOf(c: Client): string | null {
  if (!c.follow && c.platform) return c.platform;
  const snap = browser.snapshot();
  return snap.active ?? snap.pages[0]?.platform ?? null;
}

async function attach(c: Client) {
  const platform = targetOf(c);
  if (c.stream && c.stream.platform === platform) return;
  detach(c);
  if (!platform) {
    sendJson(c, { t: "meta", platform: null, url: "", title: "", width: 0, height: 0 });
    return;
  }
  const stream = await ensureStream(platform);
  if (!stream) {
    sendJson(c, { t: "meta", platform: null, url: "", title: "", width: 0, height: 0 });
    return;
  }
  c.stream = stream;
  stream.watchers.add(c);
  if (stream.stopTimer) {
    clearTimeout(stream.stopTimer);
    stream.stopTimer = null;
  }
  await applyLevel(stream);
  if (stream.meta) sendJson(c, { t: "meta", ...stream.meta });
  // Paint the last frame at once so switching tabs never shows a blank panel.
  if (stream.last && c.ws.readyState === c.ws.OPEN) c.ws.send(stream.last, { binary: true });
}

function detach(c: Client) {
  const s = c.stream;
  if (!s) return;
  c.stream = null;
  s.watchers.delete(c);
  if (s.watchers.size === 0 && !s.stopTimer) {
    s.stopTimer = setTimeout(() => void stopStream(s), 3_000);
    s.stopTimer.unref?.();
  }
}

async function ensureStream(platform: string): Promise<Stream | null> {
  const existing = streams.get(platform);
  if (existing && !existing.page.isClosed()) return existing;
  if (existing) await stopStream(existing);
  const page = browser.pageOf(platform);
  if (!page) return null;
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch (err) {
    log.warn(`cannot open a CDP session for ${platform}`, err);
    return null;
  }
  const stream: Stream = { platform, page, session, watchers: new Set(), level: "medium", last: null, meta: null, stopTimer: null, frames: 0, started: false, off: () => undefined };
  streams.set(platform, stream);
  session.on("Page.screencastFrame", (ev: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
    session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => undefined);
    onFrame(stream, ev);
  });
  // A cross-site navigation can end the screencast; start it again when the new document is ready.
  const restart = () => {
    if (streams.get(platform) === stream && stream.watchers.size) void startScreencast(stream);
  };
  const closed = () => void stopStream(stream);
  page.on("load", restart);
  page.on("close", closed);
  stream.off = () => {
    page.off("load", restart);
    page.off("close", closed);
  };
  return stream;
}

async function startScreencast(s: Stream) {
  const q = QUALITY[s.level];
  try {
    await s.session.send("Page.startScreencast", { format: "jpeg", quality: q.quality, maxWidth: q.maxWidth, maxHeight: q.maxHeight, everyNthFrame: 1 });
    s.started = true;
  } catch (err) {
    log.warn(`screencast for ${s.platform} did not start`, err);
  }
}

/** The stream runs at the best level any watcher asked for. */
async function applyLevel(s: Stream) {
  let best: Level = "low";
  for (const w of s.watchers) if (LEVEL_ORDER.indexOf(w.level) > LEVEL_ORDER.indexOf(best)) best = w.level;
  if (s.started && best === s.level) return;
  s.level = best;
  await startScreencast(s);
}

async function stopStream(s: Stream) {
  if (streams.get(s.platform) === s) streams.delete(s.platform);
  if (s.stopTimer) clearTimeout(s.stopTimer);
  s.off();
  for (const w of s.watchers) {
    w.stream = null;
    void attach(w);
  }
  s.watchers.clear();
  try {
    if (!s.page.isClosed()) await s.session.send("Page.stopScreencast");
  } catch {
    /* page already gone */
  }
  await s.session.detach().catch(() => undefined);
}

function onFrame(s: Stream, ev: { data: string; metadata: { deviceWidth: number; deviceHeight: number } }) {
  const buf = Buffer.from(ev.data, "base64");
  s.last = buf;
  s.frames++;
  const meta: Meta = {
    platform: s.platform,
    url: s.page.url(),
    title: browser.snapshot().pages.find((p) => p.platform === s.platform)?.title ?? "",
    width: Math.round(ev.metadata.deviceWidth),
    height: Math.round(ev.metadata.deviceHeight),
  };
  const metaChanged = !s.meta || s.meta.url !== meta.url || s.meta.width !== meta.width || s.meta.height !== meta.height || s.meta.title !== meta.title;
  s.meta = meta;
  for (const w of s.watchers) {
    if (w.ws.readyState !== w.ws.OPEN) continue;
    if (metaChanged) sendJson(w, { t: "meta", ...meta });
    // A slow link gets the next frame instead of a growing backlog.
    if (w.ws.bufferedAmount > MAX_BUFFERED) continue;
    w.ws.send(buf, { binary: true });
  }
}

/* ---------- following the agent ---------- */

bus.on("browser", (snap: BrowserSnapshot) => {
  for (const c of clients) {
    sendJson(c, { t: "state", browser: snap });
    if (c.follow && targetOf(c) !== c.stream?.platform) void attach(c);
  }
});

/* ---------- commands from the UI ---------- */

const BUTTONS = ["left", "middle", "right"] as const;

async function handle(c: Client, msg: Record<string, unknown>) {
  const t = String(msg.t ?? "");
  if (t === "watch" && typeof msg.platform === "string") {
    c.follow = false;
    c.platform = msg.platform;
    // In headed mode only the front tab paints, so the tab you pick comes to the front, unless the agent is mid-task.
    if (!browser.busy) await browser.bringToFront(msg.platform);
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
      if (c.stream) await applyLevel(c.stream);
    }
    return;
  }
  if (t === "override") {
    c.override = !!msg.on;
    return;
  }

  const s = c.stream;
  if (!s || s.page.isClosed()) return;
  const page = s.page;
  const meta = s.meta;

  if (t === "nav" || t === "back" || t === "forward" || t === "reload") {
    if (browser.busy && !c.override) return sendJson(c, { t: "error", message: `The agent is busy: ${browser.busy.label}.` });
    try {
      if (t === "nav") {
        let url = String(msg.url ?? "").trim();
        if (!url) return;
        if (!/^[a-z]+:\/\//i.test(url)) url = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } else if (t === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else if (t === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (err) {
      sendJson(c, { t: "error", message: (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200) });
    }
    return;
  }

  // Input. Read-only while the agent works, unless the user took control on purpose.
  if (browser.busy && !c.override) return;
  if (!meta) return;
  const px = (v: unknown) => Math.max(0, Math.min(meta.width, Number(v) * meta.width));
  const py = (v: unknown) => Math.max(0, Math.min(meta.height, Number(v) * meta.height));

  try {
    if (t === "mouse") {
      const x = px(msg.x);
      const y = py(msg.y);
      const button = BUTTONS[Number(msg.button) || 0] ?? "left";
      if (msg.kind === "move") await page.mouse.move(x, y);
      else if (msg.kind === "down") {
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
      } else if (msg.kind === "up") {
        await page.mouse.move(x, y);
        await page.mouse.up({ button });
      }
    } else if (t === "wheel") {
      await page.mouse.move(px(msg.x), py(msg.y));
      await page.mouse.wheel(Number(msg.dx) || 0, Number(msg.dy) || 0);
    } else if (t === "key") {
      const key = String(msg.key ?? "");
      if (!key) return;
      try {
        if (msg.kind === "down") await page.keyboard.down(key);
        else await page.keyboard.up(key);
      } catch (err) {
        // Keys Playwright's layout does not know (dead keys, IME) still produce their character.
        if (msg.kind === "down" && key.length === 1) await page.keyboard.insertText(key);
        else throw err;
      }
    } else if (t === "text") {
      const text = String(msg.text ?? "").slice(0, 20_000);
      if (text) await page.keyboard.insertText(text);
    }
  } catch (err) {
    log.warn(`input on ${s.platform} failed`, err);
  }
}
