import { keepSubscribed, liveFrameChannel, packEnvelope, resilientRedis } from "../../packages/realtime/src/index.js";
import { bus } from "../bus.js";
import { currentOrgId } from "../db.js";
import { logger } from "../logger.js";
import { acquireStream, applyCommand, refreshLevel, releaseStream, LEVEL_ORDER, type Level, type Meta, type Sink } from "./live-stream.js";
import type { BrowserSnapshot } from "./manager.js";

/*
  The source half of the remote live view, running where the browser lives. Api instances
  say what they are watching (a heartbeat, so a dead api stops a stream by silence) and
  forward viewer commands; this relay drives the screencasts and publishes the frames.

    ctl    (api → here)  { t: "watching", wants: [{ org, platform, level }] }   every ~3s and on change
                         { t: "cmd", org, platform, override, msg }
    frame  (here → api)  one binary message per frame on the STREAM'S OWN channel
                         acp:1:frame:{org}:{platform} — a JSON header line
                         { platform, org, meta, metaChanged } followed by the raw JPEG bytes
                         (packEnvelope); errors are a header-only { platform, org, error }.
                         An api subscribes to a stream's channel only while it has a viewer
                         for that (org, platform), so nobody parses frames nobody watches.
    state  (here → api)  { org, snap } on acp:live:state — the browser snapshot, tagged with
                         the workspace it describes, so an api delivers it only to that
                         workspace's viewers (the events bridge would lose the org).
*/

const log = logger("live-relay");

export const LIVE_CTL_CHANNEL = "acp:live:ctl";
export const LIVE_STATE_CHANNEL = "acp:live:state";
const WATCH_TTL_MS = 10_000;

interface Want {
  level: Level;
  lastSeen: number;
  sink: Sink;
  attached: boolean;
}

export async function startLiveRelay(redisUrl: string): Promise<{ connected: boolean; stop(): Promise<void> }> {
  const onError = (err: unknown) => log.warn("live relay redis error", err);
  const pub = resilientRedis(redisUrl, onError);
  const sub = resilientRedis(redisUrl, onError);
  const subscribed = keepSubscribed(sub, LIVE_CTL_CHANNEL, onError);

  const wants = new Map<string, Want>();

  const sinkFor = (org: number, platform: string, level: Level): Sink => ({
    level,
    congested: () => false, // redis takes every frame; the api side drops for slow sockets
    deliver: (frame, meta, metaChanged) => {
      // Many per second: while Redis is down a dropped frame is expected, and the outage is
      // already reported by the client. The JPEG travels as raw bytes, never base64.
      pub.publish(liveFrameChannel(org, platform), packEnvelope({ platform, org, meta, metaChanged }, frame)).catch(() => undefined);
    },
  });

  // Browser snapshots cross here rather than over the events bridge: this handler runs
  // synchronously inside the emitter's workspace scope, so the org can travel with the
  // snapshot and the api side can keep each workspace's tabs to its own viewers.
  const onSnapshot = (snap: BrowserSnapshot) => {
    const org = currentOrgId() ?? 1;
    pub.publish(LIVE_STATE_CHANNEL, JSON.stringify({ org, snap })).catch(() => undefined);
  };
  bus.on("browser", onSnapshot);

  sub.on("message", (_ch: string, raw: string) => {
    void (async () => {
      let msg: { t?: string; wants?: { org?: number; platform: string; level?: string }[]; org?: number; platform?: string; override?: boolean; msg?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "watching" && Array.isArray(msg.wants)) {
        const now = Date.now();
        for (const w of msg.wants) {
          if (!w?.platform) continue;
          const org = Number(w.org) || 1;
          const key = `${org}:${w.platform}`;
          const level = LEVEL_ORDER.includes(w.level as Level) ? (w.level as Level) : "medium";
          let cur = wants.get(key);
          if (!cur) {
            cur = { level, lastSeen: now, sink: sinkFor(org, w.platform, level), attached: false };
            wants.set(key, cur);
          }
          cur.lastSeen = now;
          if (cur.level !== level) {
            cur.level = level;
            cur.sink.level = level;
            await refreshLevel(org, w.platform);
          }
          if (!cur.attached) {
            cur.attached = await acquireStream(org, w.platform, cur.sink);
          }
        }
        return;
      }
      if (msg.t === "cmd" && msg.platform && msg.msg) {
        const org = Number(msg.org) || 1;
        const outcome = await applyCommand(org, msg.platform, msg.msg, { override: !!msg.override });
        if (outcome.error) pub.publish(liveFrameChannel(org, msg.platform), packEnvelope({ platform: msg.platform, org, error: outcome.error })).catch(onError);
      }
    })().catch(onError);
  });

  // A platform nobody refreshed drops out; a dead api instance costs one TTL, not a stream forever.
  const reap = setInterval(() => {
    const cutoff = Date.now() - WATCH_TTL_MS;
    for (const [key, w] of wants) {
      if (w.lastSeen >= cutoff) continue;
      wants.delete(key);
      const [org, platform] = [Number(key.split(":")[0]), key.slice(key.indexOf(":") + 1)];
      if (w.attached) releaseStream(org, platform, w.sink);
    }
  }, 5_000);
  reap.unref?.();

  const connected = await subscribed;
  if (connected) log.info("live view relay up");
  else log.warn("live view relay: Redis not reachable yet; the live view starts working once it is");
  return {
    connected,
    stop: async () => {
      clearInterval(reap);
      bus.off("browser", onSnapshot);
      for (const [key, w] of wants) if (w.attached) releaseStream(Number(key.split(":")[0]), key.slice(key.indexOf(":") + 1), w.sink);
      wants.clear();
      sub.disconnect();
      pub.disconnect();
    },
  };
}
