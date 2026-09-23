import { EventEmitter } from "node:events";

/**
 * In-process event bus. The database and the browser announce changes here and the
 * live stream (src/live.ts) forwards them to every open UI over server-sent events.
 *
 *   message:row      a message row changed (MessageWithTask)
 *   message:deleted  { id, conversation_id }
 *   run              a run row changed (Run)
 *   run-event        a line was added to a run's timeline (RunEvent)
 *   task             a task row changed (Task); task:deleted { id }
 *   notification     a notification was added (EventRow)
 *   platform:row     a provider's state changed (provider id)
 *   conversation     { action: "created" | "updated" | "deleted", conversation }
 *   browser          the browser snapshot (active tab, busy task, open pages)
 *   settings         { approvalMode }
 *   pairing          a sign-in from the user's computer changed state (PairingView)
 *   log              a log line (LogLine), for the Logs view
 */
export const bus = new EventEmitter();
bus.setMaxListeners(64);
