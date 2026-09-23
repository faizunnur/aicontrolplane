import type { Request, Response } from "express";
import { bus } from "./bus.js";
import type { MessageWithTask } from "./db.js";
import { logger } from "./logger.js";
import { getPlatform } from "./platforms.js";
import { connectionCard, expandMessage } from "./view.js";

/*
  Server-sent events for the UI: every open page gets message, connection, browser,
  conversation and settings updates the moment they happen, so nothing polls.
*/

const log = logger("live");
const clients = new Set<Response>();

function broadcast(event: string, data: unknown) {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const failed: Response[] = [];
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      failed.push(res);
    }
  }
  // Drop before logging: a log line is itself broadcast, and must not retry the dead client.
  for (const res of failed) clients.delete(res);
  if (failed.length && event !== "log") log.warn(`dropped ${failed.length} stream client(s) that could not be written to`);
}

// "msg" rather than "message": an EventSource treats unnamed events as "message" too, so keep the names distinct.
bus.on("message:row", (row: MessageWithTask) => broadcast("msg", expandMessage(row)));
bus.on("message:deleted", (info: { id: number; conversation_id: number | null }) => broadcast("msg-deleted", info));
bus.on("platform:row", (id: string) => {
  const p = getPlatform(id);
  if (p) broadcast("connection", connectionCard(p));
});
bus.on("browser", (state: unknown) => broadcast("browser", state));
bus.on("conversation", (c: unknown) => broadcast("conversation", c));
bus.on("settings", (s: unknown) => broadcast("settings", s));
bus.on("run", (r: unknown) => broadcast("run", r));
bus.on("run-event", (e: unknown) => broadcast("run-event", e));
bus.on("task", (t: unknown) => broadcast("task", t));
bus.on("task:deleted", (t: unknown) => broadcast("task-deleted", t));
bus.on("notification", (n: unknown) => broadcast("notification", n));
bus.on("approval", (a: unknown) => broadcast("approval", a));
bus.on("policy", (p: unknown) => broadcast("policy", p));
bus.on("agent", (a: unknown) => broadcast("agent", a));
bus.on("agent:deleted", (a: unknown) => broadcast("agent-deleted", a));
bus.on("log", (l: unknown) => broadcast("log", l));

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
  clients.add(res);
  log.debug(`stream client connected (${clients.size} open)`);
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
    log.debug(`stream client left (${clients.size} open)`);
  });
}
