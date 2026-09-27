import type { CDPSession, Page } from "playwright";
import { addAudit } from "../db.js";
import { logger } from "../logger.js";
import { browser } from "./manager.js";

/*
  The screencast source: turns a provider's tab into a stream of JPEG frames for whoever is
  watching, and applies viewer commands (navigation, mouse, keyboard) to the page. Sinks are
  abstract on purpose — a local WebSocket client and a Redis relay to another process attach
  the same way. Runs only in the process that holds the browser.
*/

const log = logger("live-stream");

export const QUALITY = {
  low: { quality: 35, maxWidth: 960, maxHeight: 640 },
  medium: { quality: 55, maxWidth: 1280, maxHeight: 900 },
  high: { quality: 75, maxWidth: 1680, maxHeight: 1100 },
} as const;
export type Level = keyof typeof QUALITY;
export const LEVEL_ORDER: Level[] = ["low", "medium", "high"];

export interface Meta {
  platform: string;
  url: string;
  title: string;
  width: number;
  height: number;
}

/** Whatever consumes frames: a WS client, or the Redis relay standing in for many of them. */
export interface Sink {
  level: Level;
  deliver(frame: Buffer, meta: Meta, metaChanged: boolean): void;
  /** True when the sink cannot take another frame right now (it gets the next one instead). */
  congested(): boolean;
}

interface Stream {
  platform: string;
  page: Page;
  session: CDPSession;
  sinks: Set<Sink>;
  level: Level;
  last: Buffer | null;
  meta: Meta | null;
  stopTimer: NodeJS.Timeout | null;
  started: boolean;
  off: () => void;
}

const streams = new Map<string, Stream>();

export function lastFrame(platform: string): { frame: Buffer; meta: Meta } | null {
  const s = streams.get(platform);
  return s?.last && s.meta ? { frame: s.last, meta: s.meta } : null;
}

/** Attach a sink to a platform's stream, starting it if needed. Returns false when there is no tab. */
export async function acquireStream(platform: string, sink: Sink): Promise<boolean> {
  const stream = await ensureStream(platform);
  if (!stream) return false;
  stream.sinks.add(sink);
  if (stream.stopTimer) {
    clearTimeout(stream.stopTimer);
    stream.stopTimer = null;
  }
  await applyLevel(stream);
  if (stream.last && stream.meta) sink.deliver(stream.last, stream.meta, true);
  return true;
}

export function releaseStream(platform: string, sink: Sink): void {
  const s = streams.get(platform);
  if (!s) return;
  s.sinks.delete(sink);
  if (s.sinks.size === 0 && !s.stopTimer) {
    s.stopTimer = setTimeout(() => void stopStream(s), 3_000);
    s.stopTimer.unref?.();
  }
}

/** Re-evaluate the stream's quality after a sink changed its level. */
export async function refreshLevel(platform: string): Promise<void> {
  const s = streams.get(platform);
  if (s) await applyLevel(s);
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
  const stream: Stream = { platform, page, session, sinks: new Set(), level: "medium", last: null, meta: null, stopTimer: null, started: false, off: () => undefined };
  streams.set(platform, stream);
  session.on("Page.screencastFrame", (ev: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
    session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => undefined);
    onFrame(stream, ev);
  });
  // A cross-site navigation can end the screencast; start it again when the new document is ready.
  const restart = () => {
    if (streams.get(platform) === stream && stream.sinks.size) void startScreencast(stream);
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
    // Chromium refuses a second start while one is active; a (re)start always begins from stopped.
    if (s.started) await s.session.send("Page.stopScreencast").catch(() => undefined);
    await s.session.send("Page.startScreencast", { format: "jpeg", quality: q.quality, maxWidth: q.maxWidth, maxHeight: q.maxHeight, everyNthFrame: 1 });
    s.started = true;
  } catch (err) {
    if (/already active/i.test(err instanceof Error ? err.message : String(err))) {
      s.started = true;
      return;
    }
    log.warn(`screencast for ${s.platform} did not start`, err);
  }
}

/** The stream runs at the best level any sink asked for. */
async function applyLevel(s: Stream) {
  let best: Level = "low";
  for (const sink of s.sinks) if (LEVEL_ORDER.indexOf(sink.level) > LEVEL_ORDER.indexOf(best)) best = sink.level;
  if (s.started && best === s.level) return;
  s.level = best;
  await startScreencast(s);
}

async function stopStream(s: Stream) {
  if (streams.get(s.platform) === s) streams.delete(s.platform);
  if (s.stopTimer) clearTimeout(s.stopTimer);
  s.off();
  s.sinks.clear();
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
  const meta: Meta = {
    platform: s.platform,
    url: s.page.url(),
    title: browser.snapshot().pages.find((p) => p.platform === s.platform)?.title ?? "",
    width: Math.round(ev.metadata.deviceWidth),
    height: Math.round(ev.metadata.deviceHeight),
  };
  const metaChanged = !s.meta || s.meta.url !== meta.url || s.meta.width !== meta.width || s.meta.height !== meta.height || s.meta.title !== meta.title;
  s.meta = meta;
  for (const sink of s.sinks) {
    // A slow consumer gets the next frame instead of a growing backlog.
    if (sink.congested()) continue;
    sink.deliver(buf, meta, metaChanged);
  }
}

/* ---------- viewer commands applied to the page ---------- */

const BUTTONS = ["left", "middle", "right"] as const;

export interface CommandOutcome {
  error?: string;
}

/**
 * Apply one viewer command (nav / mouse / wheel / key / text) to a platform's tab. The busy
 * guard and the audit live here, next to the page — whichever process the viewer's socket
 * terminates on.
 */
export async function applyCommand(platform: string, msg: Record<string, unknown>, opts: { override: boolean; actor?: string } = { override: false }): Promise<CommandOutcome> {
  const s = streams.get(platform);
  if (!s || s.page.isClosed()) return {};
  const page = s.page;
  const meta = s.meta;
  const t = String(msg.t ?? "");

  if (t === "nav" || t === "back" || t === "forward" || t === "reload") {
    if (browser.busy && !opts.override) return { error: `The agent is busy: ${browser.busy.label}.` };
    try {
      if (t === "nav") {
        let url = String(msg.url ?? "").trim();
        if (!url) return {};
        if (!/^[a-z]+:\/\//i.test(url)) url = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        if (!/^https?:\/\//i.test(url)) return { error: "Only http and https addresses can be opened here." };
        await addAudit({ actor: opts.actor ?? "you", action: "browser.navigate", target: platform, detail: url.slice(0, 300) });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } else if (t === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else if (t === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (err) {
      return { error: (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200) };
    }
    return {};
  }

  // Input. Read-only while the agent works, unless the user took control on purpose.
  if (browser.busy && !opts.override) return {};
  if (!meta) return {};
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
      if (!key) return {};
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
    } else if (t === "watchTab") {
      // In headed mode only the front tab paints; bring the picked tab forward unless the agent is mid-task.
      if (!browser.busy) await browser.bringToFront(platform);
    }
  } catch (err) {
    log.warn(`input on ${platform} failed`, err);
  }
  return {};
}
