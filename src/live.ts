import type { Request, Response } from "express";
import type { AuthUser } from "./auth.js";
import { bus } from "./bus.js";
import { currentOrgId, getMessage, getRun, outboxAfter, withOrg, type MessageWithTask } from "./db.js";
import { enableOnDemandEventShards, unwatchOrgEvents, watchOrgEvents } from "../packages/realtime/src/index.js";
import { logger } from "./logger.js";
import { sseClients } from "./metrics.js";
import { getPlatform } from "./platforms.js";
import { connectionCard, expandMessage } from "./view.js";

/*
  Server-sent events for the UI: every open page gets message, connection, browser,
  conversation and settings updates the moment they happen, so nothing polls. Data-layer
  events carry their outbox id as the SSE `id:` line; a client that reconnects with
  Last-Event-ID replays the log from its cursor (or is told to resync when the window
  has moved on — which the page's hello-refetch covers anyway).

  Clients are indexed by workspace: a broadcast walks only the target workspace's pages,
  and work done purely for open pages (the run-event step fold below) runs only while that
  workspace actually has one. Connect/disconnect also drives the Redis bridge's shard
  refcount, so an api replica only parses the event shards its own viewers need.
*/

// This process serves SSE, so its Redis bridge (started later, in server.ts) should
// subscribe to event shards on demand rather than to every workspace's.
enableOnDemandEventShards();

const log = logger("live");

/** A stalled page is dropped rather than buffered without bound (mirror of the WS side's cap). */
const MAX_BUFFERED = 1_500_000;

interface StreamClient {
  res: Response;
  orgId: number;
}
/** Every open page, indexed by the workspace it is allowed to see. */
const clients = new Map<number, Set<StreamClient>>();
let clientCount = 0;

function addClient(c: StreamClient) {
  let set = clients.get(c.orgId);
  if (!set) clients.set(c.orgId, (set = new Set()));
  if (set.has(c)) return;
  set.add(c);
  clientCount++;
  watchOrgEvents(c.orgId);
  sseClients.set(clientCount);
}
function removeClient(c: StreamClient) {
  const set = clients.get(c.orgId);
  if (!set?.delete(c)) return;
  if (!set.size) clients.delete(c.orgId);
  clientCount--;
  unwatchOrgEvents(c.orgId);
  sseClients.set(clientCount);
}

/** True when the write went through and the socket is keeping up; false means "drop this client". */
function writeEvent(c: StreamClient, event: string, data: unknown, id?: number): boolean {
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  try {
    c.res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    return false;
  }
  // A client that stopped reading buffers in this process's heap; past the cap it is cut
  // and reconnects fresh (the hello-refetch brings it back up to date).
  return (c.res.socket?.writableLength ?? 0) <= MAX_BUFFERED;
}

function broadcast(event: string, data: unknown, id?: number, orgId?: number) {
  // Fail closed: an event that names no workspace (boot paths, log lines) is an
  // install-level concern and reaches only the founding workspace's pages.
  const target = orgId ?? 1;
  const set = clients.get(target);
  if (!set?.size) return;
  const failed: StreamClient[] = [];
  for (const c of set) {
    if (!writeEvent(c, event, data, id)) failed.push(c);
  }
  for (const c of failed) {
    removeClient(c);
    try {
      c.res.end();
    } catch {
      /* already gone */
    }
  }
  // Drop before logging: a log line is itself broadcast, and must not retry the dead client.
  if (failed.length && event !== "log") log.warn(`dropped ${failed.length} stream client(s) that stalled or could not be written to`);
}

/** A run row bound for a page: the heavy payload columns stay server-side (the run detail route has them). */
function lightRun(r: unknown): unknown {
  if (!r || typeof r !== "object") return r;
  const { raw: _raw, details: _details, checkpoint: _checkpoint, ...rest } = r as Record<string, unknown>;
  return rest;
}

/** topic → the SSE event name and payload the UI expects. Shared by live delivery and replay. */
async function toSse(topic: string, payload: unknown): Promise<{ event: string; data: unknown } | null> {
  switch (topic) {
    case "message:row":
      return { event: "msg", data: await expandMessage(payload as MessageWithTask) };
    case "message:deleted":
      return { event: "msg-deleted", data: payload };
    case "platform:row": {
      const p = getPlatform(String(payload));
      return p ? { event: "connection", data: await connectionCard(p) } : null;
    }
    case "task:deleted":
      return { event: "task-deleted", data: payload };
    case "agent:deleted":
      return { event: "agent-deleted", data: payload };
    case "browser":
      return { event: "browser", data: payload };
    case "run":
      return { event: "run", data: lightRun(payload) };
    case "conversation":
    case "settings":
    case "run-event":
    case "task":
    case "notification":
    case "approval":
    case "policy":
    case "agent":
    case "log":
    case "pairing":
      return { event: topic, data: payload };
    default:
      return null;
  }
}

// "msg" rather than "message": an EventSource treats unnamed events as "message" too, so keep the names distinct.
// Handlers receive (payload, outboxId, orgId) from the data layer's announcer and deliver
// only to that workspace's pages; view expansions read the database, so they re-enter the
// event's own scope.
bus.on("message:row", async (row: MessageWithTask, id?: number, org?: number) => {
  if (!clients.get(org ?? 1)?.size) return; // the expansion reads the database; skip it for nobody
  broadcast("msg", await withOrg(org ?? 1, () => expandMessage(row)), id, org);
});
bus.on("message:deleted", (info: { id: number; conversation_id: number | null }, id?: number, org?: number) => broadcast("msg-deleted", info, id, org));
bus.on("platform:row", async (pid: string, id?: number, org?: number) => {
  if (!clients.get(org ?? 1)?.size) return;
  const p = getPlatform(pid);
  if (p) broadcast("connection", await withOrg(org ?? 1, () => connectionCard(p)), id, org);
});
// Snapshots emitted in a workspace's scope (the fleet announces inside the job's org) go to
// that workspace's pages; handlers run synchronously in the emitter's context, so the
// ambient org is still readable here. Orgless emits fail closed to the founding workspace.
bus.on("browser", (state: unknown, id?: number, org?: number) => broadcast("browser", state, id, org ?? currentOrgId()));
bus.on("conversation", (c: unknown, id?: number, org?: number) => broadcast("conversation", c, id, org));
bus.on("settings", (s: unknown, id?: number, org?: number) => broadcast("settings", s, id, org));
bus.on("run", (r: unknown, id?: number, org?: number) => broadcast("run", lightRun(r), id, org));
bus.on("run-event", async (e: { run_id: number; type?: string }, id?: number, org?: number) => {
  broadcast("run-event", e, id, org);
  // The thread renders a live run's steps from "msg" updates. Steps are no longer mirrored
  // onto the message row while a run executes, so refresh the open pages' view of the
  // message here — the fold costs reads, so it runs only while THIS workspace has a page open.
  if (e.type !== "step" || !clients.get(org ?? 1)?.size) return;
  try {
    await withOrg(org ?? 1, async () => {
      const run = await getRun(e.run_id);
      if (!run?.message_id) return;
      const m = await getMessage(run.message_id);
      if (m) broadcast("msg", await expandMessage(m), undefined, org);
    });
  } catch (err) {
    log.debug("live step fanout failed", err);
  }
});
bus.on("task", (t: unknown, id?: number, org?: number) => broadcast("task", t, id, org));
bus.on("task:deleted", (t: unknown, id?: number, org?: number) => broadcast("task-deleted", t, id, org));
bus.on("notification", (n: unknown, id?: number, org?: number) => broadcast("notification", n, id, org));
bus.on("approval", (a: unknown, id?: number, org?: number) => broadcast("approval", a, id, org));
bus.on("policy", (p: unknown, id?: number, org?: number) => broadcast("policy", p, id, org));
bus.on("agent", (a: unknown, id?: number, org?: number) => broadcast("agent", a, id, org));
bus.on("agent:deleted", (a: unknown, id?: number, org?: number) => broadcast("agent-deleted", a, id, org));
bus.on("log", (l: unknown) => broadcast("log", l));
bus.on("pairing", (p: unknown, id?: number, org?: number) => broadcast("pairing", p, id, org));
// The outbox overflowed for a workspace (locally, or on another instance — the bridge
// mirrors it): its pages must refetch state instead of trusting the stream.
bus.on("resync", (p: { org?: number } | undefined, _id?: number, org?: number) => broadcast("resync", { reason: "event log overflowed; refetch state" }, undefined, org ?? p?.org ?? 1));

export function streamClients() {
  return clientCount;
}

/** Reconnect replay is bounded: beyond this many rows the client refetches instead. */
const REPLAY_MAX = 100;

/** GET /api/stream */
export function streamHandler(req: Request, res: Response) {
  // Behind requireAdmin: the stream shows exactly one workspace — the signed-in user's.
  const orgId = (res.locals.user as AuthUser | undefined)?.orgId ?? 1;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Jittered retry: a restart must not have every open dashboard reconnect on the same beat.
  res.write(`retry: ${2000 + Math.floor(Math.random() * 2000)}\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const client: StreamClient = { res, orgId };

  // Reconnect replay: everything logged since the client's cursor, oldest first — but only a
  // short stretch. A cursor further behind than REPLAY_MAX rows means many multi-query
  // expansions per reconnect; say "resync" instead and let the page's hello-refetch do one
  // cheap fetch (app.js reloads state on every reconnect's hello already).
  const lastId = Number(req.headers["last-event-id"]);
  const replay = Number.isFinite(lastId) && lastId > 0 ? lastId : null;

  void (async () => {
    if (replay !== null) {
      try {
        const rows = await outboxAfter(orgId, replay, REPLAY_MAX + 1);
        if (rows.length > REPLAY_MAX) {
          writeEvent(client, "resync", { reason: "too far behind; refetch state" });
        } else {
          for (const row of rows) {
            try {
              const mapped = await withOrg(orgId, () => toSse(row.topic, row.payload ? JSON.parse(row.payload) : null));
              if (mapped) writeEvent(client, mapped.event, mapped.data, row.id);
            } catch {
              /* one bad row must not end the replay */
            }
          }
        }
      } catch (err) {
        log.debug("sse replay failed", err);
        writeEvent(client, "resync", { reason: "replay unavailable" });
      }
    }
    addClient(client);
    log.debug(`stream client connected (${clientCount} open)${replay !== null ? ` replayed from #${replay}` : ""}`);
  })();

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(ping);
      removeClient(client);
    }
  }, 20_000);
  ping.unref?.();
  req.on("close", () => {
    clearInterval(ping);
    removeClient(client);
    log.debug(`stream client left (${clientCount} open)`);
  });
}
