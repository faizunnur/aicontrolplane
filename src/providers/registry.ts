import { getPlatform, visiblePlatforms } from "../platforms.js";
import { BrowserProviderAdapter } from "./browser-adapter.js";
import { ChatGPTAdapter } from "./chatgpt.js";
import { ClaudeAdapter } from "./claude.js";
import { CustomProviderAdapter } from "./custom.js";
import { GeminiAdapter } from "./gemini.js";
import { GrokAdapter } from "./grok.js";
import { base } from "./defaults.js";
import type { ProviderAdapter } from "./types.js";

/*
  One adapter per provider id. Built-ins get their own class; a provider the user added by
  hand gets the generic browser adapter. Adapters read their configuration live, so Settings
  edits apply at once; the registry only has to know which ids exist.
*/

const adapters = new Map<string, ProviderAdapter>();

function build(id: string): ProviderAdapter {
  const cfg = () => getPlatform(id) ?? base({ id, name: id });
  switch (id) {
    case "chatgpt":
      return new ChatGPTAdapter(id, cfg, true);
    case "claude":
      return new ClaudeAdapter(id, cfg, true);
    case "grok":
      return new GrokAdapter(id, cfg, true);
    case "gemini":
      return new GeminiAdapter(id, cfg, true);
    case "custom":
      return new CustomProviderAdapter(id, cfg);
    default:
      return new BrowserProviderAdapter(id, cfg, false);
  }
}

/** The adapter for a provider id, or undefined when no such provider is configured. */
export function getProvider(id: string): ProviderAdapter | undefined {
  if (!getPlatform(id)) return undefined;
  let a = adapters.get(id);
  if (!a) {
    a = build(id);
    adapters.set(id, a);
  }
  return a;
}

/** Same, but throws a not-found error the API can turn into a 404. */
export function requireProvider(id: string): ProviderAdapter {
  const a = getProvider(id);
  if (!a) throw Object.assign(new Error(`unknown provider ${id}`), { status: 404 });
  return a;
}

/** Providers shown in the UI: everything not hidden, built-ins first. */
export function listProviders(): ProviderAdapter[] {
  return visiblePlatforms().map((p) => getProvider(p.id)!);
}

/** Providers that can take a chat message right now. */
export function chattableProviders(): ProviderAdapter[] {
  return listProviders().filter((a) => a.supports("chat"));
}

/** What the API returns for a provider. */
export function providerView(a: ProviderAdapter) {
  const c = a.config();
  const caps = a.capabilities();
  const notes = a.capabilityNotes();
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    builtin: a.builtin,
    aliases: a.aliases,
    purpose: c.purpose,
    appUrl: c.appUrl,
    tasksUrl: c.tasksUrl,
    notes: c.notes,
    capabilities: caps,
    unsupported: (Object.keys(caps) as (keyof typeof caps)[]).filter((op) => caps[op] === null).map((op) => ({ operation: op, reason: notes[op] ?? "" })),
    connection: a.connectionStatus(),
  };
}
