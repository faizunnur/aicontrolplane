import { BrowserProviderAdapter } from "./browser-adapter.js";
import type { CapabilityNotes } from "./types.js";

/**
 * ChatGPT. Verified 2026-09-22: OpenAI documents no public API for a user's scheduled tasks
 * (only an Enterprise compliance export); they are managed at chatgpt.com/schedules and
 * results arrive as notifications and emails. Everything here goes through the browser.
 */
export class ChatGPTAdapter extends BrowserProviderAdapter {
  protected extraAliases() {
    return ["chatgpt", "gpt", "openai", "chat gpt"];
  }

  protected extraNotes(): CapabilityNotes {
    return {
      createTask: "OpenAI documents no public API for ChatGPT scheduled tasks; ask ChatGPT in a chat to create one, or use chatgpt.com/schedules.",
      updateTask: "OpenAI documents no public API for ChatGPT scheduled tasks; edit them at chatgpt.com/schedules.",
      cancelTask: "OpenAI documents no public API for ChatGPT scheduled tasks; pause or delete them at chatgpt.com/schedules.",
      runTask: "ChatGPT scheduled tasks cannot be started on demand from outside ChatGPT.",
      getRun: "ChatGPT task results are conversations; open the run's link.",
      subscribeEvents: "ChatGPT emails task results. Set IMAP_HOST, IMAP_USER and IMAP_PASS and the control plane reads them.",
    };
  }

  /** A captured run that names a conversation lives at that conversation. */
  outputUrlFor(raw: Record<string, unknown>): string | null {
    const conv = raw["conversation_id"] ?? raw["conversationId"];
    return typeof conv === "string" && conv ? `https://chatgpt.com/c/${conv}` : null;
  }
}
