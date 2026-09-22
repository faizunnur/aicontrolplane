import { EventEmitter } from "node:events";

/**
 * In-process event bus. The database and the browser announce changes here and the
 * live stream (src/live.ts) forwards them to every open UI over server-sent events.
 *
 *   message:row      a message row changed (MessageWithAgent)
 *   message:deleted  { id, conversation_id }
 *   platform:row     a platform's state changed (platform id)
 *   conversation     { action: "created" | "updated" | "deleted", conversation }
 *   browser          the browser snapshot (active tab, busy task, open pages)
 *   settings         { approvalMode }
 */
export const bus = new EventEmitter();
bus.setMaxListeners(64);
