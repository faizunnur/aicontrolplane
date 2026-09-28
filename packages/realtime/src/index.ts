import { Redis } from "ioredis";

/*
  The realtime seam: how one process's announcements reach every other process's clients.
  In the single-container mode nothing is needed — the in-process bus reaches every listener.
  In split mode the RedisBridge mirrors chosen bus topics over a Redis pub/sub channel per
  org, so an event written on a worker reaches the SSE clients of every api instance, and a
  decision on an api reaches every worker. Fire-and-forget is correct here: Postgres holds
  the truth and the outbox holds the replayable log; a dropped pub/sub message costs a
  refetch, never a fact.
*/

export interface BusLike {
  emit(topic: string, payload: unknown, outboxId?: number): unknown;
  on(topic: string, handler: (payload: unknown, outboxId?: number) => void): unknown;
}

/** The data and control topics worth mirroring across instances. Browser frames and log lines stay local. */
export const MIRRORED_TOPICS = [
  "message:row",
  "message:deleted",
  "conversation",
  "run",
  "run-event",
  "task",
  "task:deleted",
  "notification",
  "platform:row",
  "settings",
  "policy",
  "approval",
  "agent",
  "agent:deleted",
  "pairing",
  // Browser state snapshots (tabs, busy, sign-in) originate on the browser worker but the
  // dashboards hang off any api instance. Frames stay local; snapshots are small JSON.
  "browser",
] as const;

/** Where a Redis URL points, without its password — for log lines. */
export function redisTarget(redisUrl: string): string {
  try {
    const u = new URL(redisUrl);
    if (!u.hostname) return "(REDIS_URL has no host)";
    return `${u.hostname}:${u.port || "6379"}`;
  } catch {
    return "(REDIS_URL is not a valid URL)";
  }
}

/**
 * Redis carries live updates and counters, never facts, so a process must run without it.
 * This client connects in the background and keeps retrying forever; while it is down,
 * commands fail at once instead of queueing (callers already treat them as best-effort),
 * and connection errors are reported at most once a minute, naming the target.
 */
export function resilientRedis(redisUrl: string, onError: (err: unknown) => void): Redis {
  const client = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: (n) => Math.min(n * 500, 5_000) });
  const where = redisTarget(redisUrl);
  let last = 0;
  client.on("error", (err: unknown) => {
    const now = Date.now();
    if (now - last < 60_000) return;
    last = now;
    onError(new Error(`redis at ${where}: ${err instanceof Error ? err.message : String(err)} (retrying in the background)`));
  });
  return client;
}

/**
 * Subscribe now and again after every reconnect. Resolves true once subscribed, or false when
 * Redis has not answered within the grace period — the client keeps trying either way.
 */
export function keepSubscribed(sub: Redis, channel: string, onError: (err: unknown) => void, graceMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), graceMs);
    const attempt = () => {
      sub.subscribe(channel).then(() => {
        clearTimeout(timer);
        resolve(true);
      }, onError);
    };
    sub.on("ready", attempt);
    if (sub.status === "ready") attempt();
  });
}

export interface RedisBridgeOptions {
  channel?: string;
  onError?: (err: unknown) => void;
  /** How long startup waits for Redis before carrying on without it. */
  graceMs?: number;
}

/**
 * Mirror local bus topics onto a Redis channel and remote ones back onto the local bus.
 * Never throws: `connected` says whether Redis answered within the grace period.
 */
export async function startRedisBridge(bus: BusLike, redisUrl: string, opts: RedisBridgeOptions = {}): Promise<{ connected: boolean; stop(): Promise<void> }> {
  const channel = opts.channel ?? "acp:1:events";
  const onError = opts.onError ?? (() => {});
  const pub = resilientRedis(redisUrl, onError);
  const sub = resilientRedis(redisUrl, onError);
  const subscribed = keepSubscribed(sub, channel, onError, opts.graceMs);

  // bus.emit is synchronous, so this flag cleanly stops a remote delivery re-publishing itself.
  let deliveringRemote = false;

  for (const topic of MIRRORED_TOPICS) {
    bus.on(topic, (payload: unknown, outboxId?: number) => {
      if (deliveringRemote) return;
      let body: string;
      try {
        body = JSON.stringify({ topic, payload, id: outboxId });
      } catch {
        return; // unserializable payloads stay local
      }
      // A dropped event costs clients a refetch; the outage itself is reported by the client.
      pub.publish(channel, body).catch(() => undefined);
    });
  }

  sub.on("message", (_ch: string, raw: string) => {
    try {
      const { topic, payload, id } = JSON.parse(raw) as { topic: string; payload: unknown; id?: number };
      if (!MIRRORED_TOPICS.includes(topic as (typeof MIRRORED_TOPICS)[number])) return;
      deliveringRemote = true;
      try {
        bus.emit(topic, payload, id);
      } finally {
        deliveringRemote = false;
      }
    } catch (err) {
      onError(err);
    }
  });

  const connected = await subscribed;
  return {
    connected,
    stop: async () => {
      try {
        await sub.unsubscribe(channel);
      } catch {
        /* closing anyway */
      }
      sub.disconnect();
      pub.disconnect();
    },
  };
}

/** Fixed-window counter in Redis: the same limiter every instance shares. Rejects while Redis is down. */
export function redisRateLimiter(redisUrl: string, onError: (err: unknown) => void = () => {}) {
  const client = resilientRedis(redisUrl, onError);
  const count = async (key: string, windowMs: number): Promise<number> => {
    const bucket = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    const n = await client.incr(bucket);
    if (n === 1) await client.pexpire(bucket, windowMs);
    return n;
  };
  return Object.assign(count, { close: () => client.disconnect() });
}
