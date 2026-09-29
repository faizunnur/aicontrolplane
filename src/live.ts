import type { Request, Response } from "express";
import type { AuthUser } from "./auth.js";
import { bus } from "./bus.js";
import { getMessage, getRun, outboxAfter, withOrg, type MessageWithTask } from "./db.js";
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
*/

const log = logger("live");
/** Every open page, with the workspace it is allowed to see. */
const clients = new Map<Response, { orgId: number }>();

function writeEvent(res: Response, event: string, data: unknown, id?: number) {
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown, id?: number, orgId?: number) {
  if (!clients.size) return;
  // Fail closed: an event that names no workspace (boot paths, browser state, log lines) is
  // an install-level concern and reaches only the founding workspace's pages.
  const target = orgId ?? 1;
  const failed: Response[] = [];
  for (const [res, c] of clients) {
    if (c.orgId !== target) continue;
    try {
      writeEvent(res, event, data, id);
    } catch {
      failed.push(res);
    }
  }
  // Drop before logging: a log line is itself broadcast, and must not retry the dead client.
  for (const res of failed) clients.delete(res);
  if (failed.length && event !== "log") log.warn(`dropped ${failed.length} stream client(s) that could not be written to`);
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
    case "conversation":
    case "settings":
    case "run":
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
bus.on("message:row", async (row: MessageWithTask, id?: number, org?: number) => broadcast("msg", await withOrg(org ?? 1, () => expandMessage(row)), id, org));
bus.on("message:deleted", (info: { id: number; conversation_id: number | null }, id?: number, org?: number) => broadcast("msg-deleted", info, id, org));
bus.on("platform:row", async (pid: string, id?: number, org?: number) => {
  const p = getPlatform(pid);
  if (p) broadcast("connection", await withOrg(org ?? 1, () => connectionCard(p)), id, org);
});
bus.on("browser", (state: unknown) => broadcast("browser", state));
bus.on("conversation", (c: unknown, id?: number, org?: number) => broadcast("conversation", c, id, org));
bus.on("settings", (s: unknown, id?: number, org?: number) => broadcast("settings", s, id, org));
bus.on("run", (r: unknown, id?: number, org?: number) => broadcast("run", r, id, org));
bus.on("run-event", async (e: { run_id: number; type?: string }, id?: number, org?: number) => {
  broadcast("run-event", e, id, org);
  // The thread renders a live run's steps from "msg" updates. Steps are no longer mirrored
  // onto the message row while a run executes, so refresh the open pages' view of the
  // message here — folding costs a read only while someone is actually watching.
  if (!clients.size || e.type !== "step") return;
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

export function streamClients() {
  return clients.size;
}

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
  res.write("retry: 2000\n\n");
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  // Reconnect replay: everything logged since the client's cursor, oldest first. A cursor
  // older than the log's window means gaps — say so; the page refetches on hello anyway.
  const lastId = Number(req.headers["last-event-id"]);
  const replay = Number.isFinite(lastId) && lastId > 0 ? lastId : null;

  void (async () => {
    if (replay !== null) {
      try {
        const rows = await outboxAfter(orgId, replay, 1000);
        if (rows.length >= 1000) {
          writeEvent(res, "resync", { reason: "too far behind; refetch state" });
        } else {
          for (const row of rows) {
            try {
              const mapped = await withOrg(orgId, () => toSse(row.topic, row.payload ? JSON.parse(row.payload) : null));
              if (mapped) writeEvent(res, mapped.event, mapped.data, row.id);
            } catch {
              /* one bad row must not end the replay */
            }
          }
        }
      } catch (err) {
        log.debug("sse replay failed", err);
        writeEvent(res, "resync", { reason: "replay unavailable" });
      }
    }
    clients.set(res, { orgId });
    sseClients.set(clients.size);
    log.debug(`stream client connected (${clients.size} open)${replay !== null ? ` replayed from #${replay}` : ""}`);
  })();

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(ping);
      clients.delete(res);
    }
  }, 20_000);
  ping.unref?.();
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    sseClients.set(clients.size);
    log.debug(`stream client left (${clients.size} open)`);
  });
}
