import { keepSubscribed, resilientRedis } from "../../packages/realtime/src/index.js";
import { logger } from "../logger.js";
import { acquireStream, applyCommand, refreshLevel, releaseStream, LEVEL_ORDER, type Level, type Meta, type Sink } from "./live-stream.js";

/*
  The source half of the remote live view, running where the browser lives. Api instances
  say what they are watching (a heartbeat, so a dead api stops a stream by silence) and
  forward viewer commands; this relay drives the screencasts and publishes every frame.

    ctl   (api → here)  { t: "watching", wants: [{ org, platform, level }] }   every ~3s and on change
                        { t: "cmd", org, platform, override, msg }
    frame (here → api)  { org, platform, meta, metaChanged, data }             data = base64 JPEG
                        { org, platform, error }
*/

const log = logger("live-relay");

export const LIVE_CTL_CHANNEL = "acp:live:ctl";
export const LIVE_FRAME_CHANNEL = "acp:live:frame";
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
      // already reported by the client.
      pub.publish(LIVE_FRAME_CHANNEL, JSON.stringify({ org, platform, meta, metaChanged, data: frame.toString("base64") })).catch(() => undefined);
    },
  });

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
        if (outcome.error) pub.publish(LIVE_FRAME_CHANNEL, JSON.stringify({ org, platform: msg.platform, error: outcome.error })).catch(onError);
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
      for (const [key, w] of wants) if (w.attached) releaseStream(Number(key.split(":")[0]), key.slice(key.indexOf(":") + 1), w.sink);
      wants.clear();
      sub.disconnect();
      pub.disconnect();
    },
  };
}
