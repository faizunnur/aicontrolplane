import { Redis } from "ioredis";

/*
  The realtime seam: how one process's announcements reach every other process's clients.
  In the single-container mode nothing is needed — the in-process bus reaches every listener.
  In split mode the RedisBridge mirrors chosen bus topics over Redis pub/sub, so an event
  written on a worker reaches the SSE clients of every api instance, and a decision on an
  api reaches every worker. Fire-and-forget is correct here: Postgres holds the truth and
  the outbox holds the replayable log; a dropped pub/sub message costs a refetch, never a fact.

  Events are sharded by workspace so an api replica does not JSON.parse every event of every
  org: each workspace's events ride the channel of its shard (org % EVENT_SHARDS), while
  install-level and founding-workspace events ride one always-on system channel. A subscriber
  can take everything (workers) or subscribe to shards on demand as its own clients come and
  go (the api's SSE layer drives that through watchOrgEvents/unwatchOrgEvents).
*/

export interface BusLike {
  emit(topic: string, payload: unknown, outboxId?: number, orgId?: number): unknown;
  on(topic: string, handler: (payload: unknown, outboxId?: number, orgId?: number) => void): unknown;
}

/** The data and control topics worth mirroring across instances. Browser frames, snapshots and log lines stay off this bridge. */
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
  // The outbox overflowed somewhere: that workspace's clients must refetch instead of
  // trusting the stream, wherever their SSE connection happens to terminate.
  "resync",
  // The desktop display changed owner (a desktop sign-in claimed it for another workspace).
  // src/server.ts cuts every other workspace's VNC socket on it, so in split mode it must
  // cross from the browser worker to every api instance.
  "vnc-owner",
] as const;

// Browser state snapshots (tabs, busy, sign-in) no longer ride this bridge: they cross over
// the live relay's state channel (src/browser/live-relay.ts), which carries the workspace
// they belong to, so an api can deliver each snapshot only to that workspace's viewers.

/** How many event channels a deployment fans out over. Fixed: both sides must agree forever. */
export const EVENT_SHARDS = 16;
const DEFAULT_EVENT_PREFIX = "acp:1:events";

/** Which shard a workspace's events ride on. */
export function eventShardOf(orgId: number): number {
  return Math.abs(Math.trunc(orgId)) % EVENT_SHARDS;
}

/**
 * The channel one event travels on. Events that name no workspace (boot paths, install-level
 * concerns) and the founding workspace's events ride the always-on system channel — org 1 is
 * on every deployment and its operators' dashboards are always open, so on-demand buys nothing.
 */
export function eventChannelFor(orgId: number | undefined, prefix = DEFAULT_EVENT_PREFIX): string {
  if (orgId === undefined || orgId === 1) return `${prefix}:sys`;
  return `${prefix}:${eventShardOf(orgId)}`;
}

/* ---------- who is interested in which workspace's events ----------
   src/live.ts calls these as SSE clients come and go; a bridge running in on-demand mode
   subscribes to a shard while any workspace mapping to it is watched, and lets go (after a
   short linger) when the last watcher leaves. The registry is module-level on purpose: the
   SSE layer and the bridge are wired in different files, in either order. */

const orgInterest = new Map<number, number>();
interface InterestListener {
  add(orgId: number): void;
  remove(orgId: number): void;
}
const interestListeners = new Set<InterestListener>();
let onDemandRequested = false;

/** A process that will drive the refcount (the api's SSE layer) declares it before the bridge starts. */
export function enableOnDemandEventShards(): void {
  onDemandRequested = true;
}

/** One more local client watches this workspace's events. Org 1 rides the always-on system channel. */
export function watchOrgEvents(orgId: number): void {
  if (!Number.isFinite(orgId) || orgId === 1) return;
  const n = (orgInterest.get(orgId) ?? 0) + 1;
  orgInterest.set(orgId, n);
  if (n === 1) for (const l of interestListeners) l.add(orgId);
}

/** A local client of this workspace left. The last one out releases the shard (after a linger). */
export function unwatchOrgEvents(orgId: number): void {
  if (!Number.isFinite(orgId) || orgId === 1) return;
  const n = (orgInterest.get(orgId) ?? 0) - 1;
  if (n > 0) {
    orgInterest.set(orgId, n);
    return;
  }
  orgInterest.delete(orgId);
  for (const l of interestListeners) l.remove(orgId);
}

/** Test-only visibility into the refcount. */
export function watchedOrgs(): number[] {
  return [...orgInterest.keys()];
}

/* ---------- binary envelopes (the frame relay's wire format) ----------
   One JSON header line, then raw bytes. A JPEG frame travels as itself — no base64 (+33%)
   and no megastring JSON.parse on the receiving side. */

export function packEnvelope(header: Record<string, unknown>, body?: Buffer | null): Buffer {
  const head = Buffer.from(JSON.stringify(header) + "\n", "utf8");
  return body && body.length ? Buffer.concat([head, body]) : head;
}

export function unpackEnvelope(buf: Buffer): { header: Record<string, unknown>; body: Buffer } {
  const nl = buf.indexOf(0x0a);
  const headEnd = nl === -1 ? buf.length : nl;
  const header = JSON.parse(buf.subarray(0, headEnd).toString("utf8")) as Record<string, unknown>;
  return { header, body: nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1) };
}

/** The channel one tab's frames travel on: subscribed only while that (workspace, tab) has a viewer. */
export function liveFrameChannel(orgId: number, platform: string): string {
  return `acp:1:frame:${orgId}:${platform}`;
}

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
  /** Channel name prefix; the bridge derives `${prefix}:sys` and `${prefix}:{0..15}` from it. */
  prefix?: string;
  /** @deprecated older name for `prefix`. */
  channel?: string;
  onError?: (err: unknown) => void;
  /** How long startup waits for Redis before carrying on without it. */
  graceMs?: number;
  /**
   * "all": subscribe every shard (workers, and any process that consumes events for orgs it
   * serves no client of). "on-demand": subscribe a shard only while watchOrgEvents holds
   * interest in an org mapping to it. Default: "on-demand" when enableOnDemandEventShards()
   * ran in this process (the api's SSE layer does, at module load), otherwise "all".
   */
  subscribe?: "all" | "on-demand";
  /** How long an idle shard subscription lingers after its last watcher leaves. */
  lingerMs?: number;
}

/**
 * Mirror local bus topics onto sharded Redis channels and remote ones back onto the local bus.
 * Never throws: `connected` says whether Redis answered within the grace period.
 */
export async function startRedisBridge(bus: BusLike, redisUrl: string, opts: RedisBridgeOptions = {}): Promise<{ connected: boolean; stop(): Promise<void> }> {
  const prefix = opts.prefix ?? opts.channel ?? DEFAULT_EVENT_PREFIX;
  const onError = opts.onError ?? (() => {});
  const mode = opts.subscribe ?? (onDemandRequested ? "on-demand" : "all");
  const lingerMs = opts.lingerMs ?? 30_000;
  const sysChannel = `${prefix}:sys`;
  const pub = resilientRedis(redisUrl, onError);
  const sub = resilientRedis(redisUrl, onError);

  // The channels this bridge wants right now; re-asserted after every reconnect.
  const desired = new Set<string>([sysChannel]);
  if (mode === "all") for (let i = 0; i < EVENT_SHARDS; i++) desired.add(`${prefix}:${i}`);
  const subscribeNow = (channels: string[]) => {
    if (sub.status === "ready" && channels.length) sub.subscribe(...channels).catch(onError);
  };
  sub.on("ready", () => subscribeNow([...desired]));

  // Startup only waits on the system channel: shard subscriptions follow the same connection.
  const subscribed = keepSubscribed(sub, sysChannel, onError, opts.graceMs);
  subscribeNow([...desired].filter((c) => c !== sysChannel));

  /* on-demand: shard subscriptions follow the interest registry, with a linger so a viewer
     flapping between pages does not thrash SUBSCRIBE/UNSUBSCRIBE. */
  const shardOrgs = new Map<number, Set<number>>();
  const lingers = new Map<number, NodeJS.Timeout>();
  const listener: InterestListener = {
    add(orgId) {
      const shard = eventShardOf(orgId);
      let set = shardOrgs.get(shard);
      if (!set) shardOrgs.set(shard, (set = new Set()));
      set.add(orgId);
      const linger = lingers.get(shard);
      if (linger) {
        clearTimeout(linger);
        lingers.delete(shard);
      }
      const ch = `${prefix}:${shard}`;
      if (!desired.has(ch)) {
        desired.add(ch);
        subscribeNow([ch]);
      }
    },
    remove(orgId) {
      const shard = eventShardOf(orgId);
      const set = shardOrgs.get(shard);
      set?.delete(orgId);
      if (set && set.size === 0 && !lingers.has(shard)) {
        const t = setTimeout(() => {
          lingers.delete(shard);
          if (shardOrgs.get(shard)?.size) return; // interest came back while lingering
          shardOrgs.delete(shard);
          const ch = `${prefix}:${shard}`;
          desired.delete(ch);
          sub.unsubscribe(ch).catch(() => undefined);
        }, lingerMs);
        t.unref?.();
        lingers.set(shard, t);
      }
    },
  };
  if (mode === "on-demand") {
    interestListeners.add(listener);
    for (const org of orgInterest.keys()) listener.add(org); // clients that connected before the bridge came up
  }

  // bus.emit is synchronous, so this flag cleanly stops a remote delivery re-publishing itself.
  let deliveringRemote = false;

  for (const topic of MIRRORED_TOPICS) {
    bus.on(topic, (payload: unknown, outboxId?: number, orgId?: number) => {
      if (deliveringRemote) return;
      let body: string;
      try {
        // The workspace travels with the event so the receiving side delivers it to the
        // right clients, exactly as a local emit would — and picks which shard carries it.
        body = JSON.stringify({ topic, payload, id: outboxId, org: orgId });
      } catch {
        return; // unserializable payloads stay local
      }
      // A dropped event costs clients a refetch; the outage itself is reported by the client.
      pub.publish(eventChannelFor(orgId, prefix), body).catch(() => undefined);
    });
  }

  sub.on("message", (_ch: string, raw: string) => {
    try {
      const { topic, payload, id, org } = JSON.parse(raw) as { topic: string; payload: unknown; id?: number; org?: number };
      if (!MIRRORED_TOPICS.includes(topic as (typeof MIRRORED_TOPICS)[number])) return;
      deliveringRemote = true;
      try {
        bus.emit(topic, payload, id, org);
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
      interestListeners.delete(listener);
      for (const t of lingers.values()) clearTimeout(t);
      lingers.clear();
      try {
        await sub.unsubscribe(...desired);
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
