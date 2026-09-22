import type { Request, Response } from "express";
import { bus } from "./bus.js";
import type { MessageWithAgent } from "./db.js";
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
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      log.warn("dropping stream client", err);
      clients.delete(res);
    }
  }
}

// "msg" rather than "message": an EventSource treats unnamed events as "message" too, so keep the names distinct.
bus.on("message:row", (row: MessageWithAgent) => broadcast("msg", expandMessage(row)));
bus.on("message:deleted", (info: { id: number; conversation_id: number | null }) => broadcast("msg-deleted", info));
bus.on("platform:row", (id: string) => {
  const p = getPlatform(id);
  if (p) broadcast("connection", connectionCard(p));
});
bus.on("browser", (state: unknown) => broadcast("browser", state));
bus.on("conversation", (c: unknown) => broadcast("conversation", c));
bus.on("settings", (s: unknown) => broadcast("settings", s));

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
  });
}
