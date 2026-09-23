import { BrowserProviderAdapter } from "./browser-adapter.js";
import type { CapabilityNotes, SignInMode } from "./types.js";

/**
 * Grok (grok.com). Verified 2026-09-22: xAI's Automations (scheduled and email-triggered jobs)
 * have no documented management API; the xAI API covers model calls only. Browser throughout.
 * Its sign-in page (accounts.x.ai) sits behind a Cloudflare bot check that refuses any browser
 * running in a datacenter, automated or not (verified 2026-09-23 with a plain Chrome window on the
 * cloud desktop). So the sign-in happens on the user's own computer and the session is handed over.
 */
export class GrokAdapter extends BrowserProviderAdapter {
  protected extraAliases() {
    return ["grok", "xai", "x.ai"];
  }

  protected defaultSignIn(): SignInMode {
    return "local";
  }

  protected extraNotes(): CapabilityNotes {
    return {
      createTask: "xAI documents no management API for Grok automations; create them on grok.com.",
      updateTask: "xAI documents no management API for Grok automations; edit them on grok.com.",
      cancelTask: "xAI documents no management API for Grok automations; pause or delete them on grok.com.",
      runTask: "Grok automations cannot be started on demand from outside Grok.",
      getRun: "Open the automation on grok.com to read its output.",
    };
  }
}
