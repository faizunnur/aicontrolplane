import type { Request, Response } from "express";
import { bus } from "./bus.js";
import { getMessage, getRun, outboxAfter, type MessageWithTask } from "./db.js";
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
const clients = new Set<Response>();

function writeEvent(res: Response, event: string, data: unknown, id?: number) {
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown, id?: number) {
  if (!clients.size) return;
  const failed: Response[] = [];
  for (const res of clients) {
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
bus.on("message:row", async (row: MessageWithTask, id?: number) => broadcast("msg", await expandMessage(row), id));
bus.on("message:deleted", (info: { id: number; conversation_id: number | null }, id?: number) => broadcast("msg-deleted", info, id));
bus.on("platform:row", async (pid: string, id?: number) => {
  const p = getPlatform(pid);
  if (p) broadcast("connection", await connectionCard(p), id);
});
bus.on("browser", (state: unknown) => broadcast("browser", state));
bus.on("conversation", (c: unknown, id?: number) => broadcast("conversation", c, id));
bus.on("settings", (s: unknown) => broadcast("settings", s));
bus.on("run", (r: unknown, id?: number) => broadcast("run", r, id));
bus.on("run-event", async (e: { run_id: number; type?: string }, id?: number) => {
  broadcast("run-event", e, id);
  // The thread renders a live run's steps from "msg" updates. Steps are no longer mirrored
  // onto the message row while a run executes, so refresh the open pages' view of the
  // message here — folding costs a read only while someone is actually watching.
  if (!clients.size || e.type !== "step") return;
  try {
    const run = await getRun(e.run_id);
    if (!run?.message_id) return;
    const m = await getMessage(run.message_id);
    if (m) broadcast("msg", await expandMessage(m));
  } catch (err) {
    log.debug("live step fanout failed", err);
  }
});
bus.on("task", (t: unknown, id?: number) => broadcast("task", t, id));
bus.on("task:deleted", (t: unknown, id?: number) => broadcast("task-deleted", t, id));
bus.on("notification", (n: unknown, id?: number) => broadcast("notification", n, id));
bus.on("approval", (a: unknown, id?: number) => broadcast("approval", a, id));
bus.on("policy", (p: unknown) => broadcast("policy", p));
bus.on("agent", (a: unknown, id?: number) => broadcast("agent", a, id));
bus.on("agent:deleted", (a: unknown, id?: number) => broadcast("agent-deleted", a, id));
bus.on("log", (l: unknown) => broadcast("log", l));
bus.on("pairing", (p: unknown) => broadcast("pairing", p));

export function streamClients() {
  return clients.size;
}

/** GET /api/stream */
export function streamHandler(req: Request, res: Response) {
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
        const rows = await outboxAfter(replay, 1000);
        if (rows.length >= 1000) {
          writeEvent(res, "resync", { reason: "too far behind; refetch state" });
        } else {
          for (const row of rows) {
            try {
              const mapped = await toSse(row.topic, row.payload ? JSON.parse(row.payload) : null);
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
    clients.add(res);
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
