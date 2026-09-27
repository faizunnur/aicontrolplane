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

export interface RedisBridgeOptions {
  channel?: string;
  onError?: (err: unknown) => void;
}

/** Mirror local bus topics onto a Redis channel and remote ones back onto the local bus. */
export async function startRedisBridge(bus: BusLike, redisUrl: string, opts: RedisBridgeOptions = {}): Promise<{ stop(): Promise<void> }> {
  const channel = opts.channel ?? "acp:1:events";
  const onError = opts.onError ?? (() => {});
  const pub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  const sub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  pub.on("error", onError);
  sub.on("error", onError);
  await pub.connect();
  await sub.connect();
  await sub.subscribe(channel);

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
      pub.publish(channel, body).catch(onError);
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

  return {
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

/** Fixed-window counter in Redis: the same limiter every instance shares. */
export function redisRateLimiter(redisUrl: string, onError: (err: unknown) => void = () => {}) {
  const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  client.on("error", onError);
  let connected = false;
  return async (key: string, windowMs: number): Promise<number> => {
    if (!connected) {
      await client.connect();
      connected = true;
    }
    const bucket = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    const n = await client.incr(bucket);
    if (n === 1) await client.pexpire(bucket, windowMs);
    return n;
  };
}
