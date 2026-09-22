import { BrowserProviderAdapter } from "./browser-adapter.js";
import type { CapabilityNotes } from "./types.js";

/**
 * Gemini (gemini.google.com). Verified 2026-09-22: the Gemini app's scheduled actions have no
 * public API (the Gemini API's managed-agent triggers are a separate developer product, not the
 * user's app actions). Chat selectors are best-effort defaults and untested; the scheduled-actions
 * page address is left empty until it is known, so listTasks reports unsupported rather than
 * pretending to capture something.
 */
export class GeminiAdapter extends BrowserProviderAdapter {
  protected extraAliases() {
    return ["gemini", "google gemini", "bard"];
  }

  protected extraNotes(): CapabilityNotes {
    const c = this.cfg();
    return {
      listTasks: c.tasksUrl ? undefined : "Google documents no API for the Gemini app's scheduled actions. Add the scheduled-actions page address in AI setup and the control plane reads it through the browser.",
      createTask: "Google documents no API for Gemini scheduled actions; create them in the Gemini app.",
      updateTask: "Google documents no API for Gemini scheduled actions; edit them in the Gemini app.",
      cancelTask: "Google documents no API for Gemini scheduled actions; pause or delete them in the Gemini app.",
      runTask: "Gemini scheduled actions cannot be started on demand from outside the app.",
      getRun: "Open the action in the Gemini app to read its output.",
    };
  }
}
