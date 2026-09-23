import type { PlatformConfig } from "../types.js";

/*
  Built-in provider configuration. Every field can be overridden per provider in
  DATA_DIR/platforms.json (edited from Settings › AI setup). Selectors are the best current
  knowledge of each web app and are meant to be tuned when a site changes its layout.
  Pure data: nothing here may import the browser, the database or an adapter.
*/

export const base = (p: Partial<PlatformConfig> & { id: string; name: string }): PlatformConfig => ({
  appUrl: "",
  tasksUrl: "",
  capturePatterns: [],
  loginUrlPatterns: [],
  sessionCookie: "",
  cookieDomain: "",
  sessionDomains: [],
  loggedInSelector: "",
  loggedOutSelector: "",
  nativeUrlTemplate: "",
  snapshotSelector: "main",
  actions: {},
  notes: "",
  purpose: "",
  chatUrl: "",
  composerSelector: "",
  sendSelector: "",
  replySelector: "",
  busySelector: "",
  hidden: false,
  ...p,
});

export const CHATGPT_DEFAULTS = base({
  id: "chatgpt",
  name: "ChatGPT",
  appUrl: "https://chatgpt.com/",
  chatUrl: "https://chatgpt.com/",
  // Scheduled tasks moved to a dedicated page in June 2026 (help.openai.com, "Scheduled tasks in ChatGPT").
  tasksUrl: "https://chatgpt.com/schedules",
  purpose: "General assistant: research, writing, and scheduled tasks that run on their own.",
  capturePatterns: ["backend-api/.*(task|schedul|automation|recurr)", "/api/.*(task|schedul|automation)"],
  loginUrlPatterns: ["auth\\.openai\\.com", "/auth/login", "/log-in", "chatgpt\\.com/auth"],
  sessionCookie: "__Secure-next-auth.session-token",
  cookieDomain: "chatgpt.com",
  sessionDomains: ["openai.com"],
  loggedOutSelector: '[data-testid="login-button"], [data-testid="signup-button"]',
  composerSelector: "#prompt-textarea",
  sendSelector: 'button[data-testid="send-button"]',
  replySelector: '[data-message-author-role="assistant"]',
  busySelector: 'button[data-testid="stop-button"]',
  notes: "Scheduled tasks are managed at chatgpt.com/schedules.",
});

export const CLAUDE_DEFAULTS = base({
  id: "claude",
  name: "Claude",
  appUrl: "https://claude.ai/",
  chatUrl: "https://claude.ai/new",
  // Claude Code routines (scheduled cloud agents) are listed here (code.claude.com/docs/en/routines).
  tasksUrl: "https://claude.ai/code/routines",
  purpose: "Coding, documents and analysis; Claude Code routines and Cowork.",
  capturePatterns: ["claude\\.ai/api/.*(routine|schedul|task|session|cowork)"],
  loginUrlPatterns: ["claude\\.ai/login", "/login\\b", "auth\\.anthropic", "accounts\\.anthropic"],
  sessionCookie: "sessionKey",
  cookieDomain: "claude.ai",
  loggedOutSelector: 'a[href*="/login"]',
  composerSelector: 'div[contenteditable="true"]',
  sendSelector: 'button[aria-label="Send message"]',
  replySelector: '[data-testid="assistant-message"], .font-claude-message, .font-claude-response',
  busySelector: 'button[aria-label="Stop response"]',
  notes: "Claude Code routines and remote sessions.",
});

export const GROK_DEFAULTS = base({
  id: "grok",
  name: "Grok",
  appUrl: "https://grok.com/",
  chatUrl: "https://grok.com/",
  tasksUrl: "https://grok.com/",
  purpose: "News, X/Twitter trends and quick answers; Grok automations.",
  capturePatterns: ["grok\\.com/rest/.*(bot|routine|task|schedul|agent|automation)", "grok\\.com/api/.*(bot|routine|task|schedul|agent|automation)"],
  loginUrlPatterns: ["accounts\\.x\\.ai", "/sign-in", "/login\\b"],
  sessionCookie: "sso",
  cookieDomain: "grok.com",
  // The sign-in itself happens on accounts.x.ai; its cookies are part of the session.
  sessionDomains: ["x.ai"],
  loggedOutSelector: 'a[href*="sign-in"], a[href*="/login"], a[href*="accounts.x.ai"]',
  composerSelector: "textarea",
  sendSelector: "",
  replySelector: '[class*="response"], [class*="assistant"], main .prose',
  busySelector: 'button[aria-label="Stop"]',
  notes: "Grok automations (scheduled and email-triggered jobs).",
});

export const GEMINI_DEFAULTS = base({
  id: "gemini",
  name: "Gemini",
  appUrl: "https://gemini.google.com/app",
  chatUrl: "https://gemini.google.com/app",
  // The scheduled-actions page has no documented address; set it in AI setup to start capturing actions.
  tasksUrl: "",
  purpose: "Google workspace, search-grounded answers and Gemini scheduled actions.",
  capturePatterns: ["gemini\\.google\\.com/.*(schedul|action|task)"],
  loginUrlPatterns: ["accounts\\.google\\.com", "/signin", "ServiceLogin"],
  sessionCookie: "__Secure-1PSID",
  cookieDomain: "google.com",
  loggedOutSelector: 'a[href*="accounts.google.com"]',
  // Best-effort selectors for the Gemini web app; untested here, tune in AI setup if chat does not work.
  composerSelector: 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]',
  sendSelector: 'button[aria-label="Send message"]',
  replySelector: "message-content, .model-response-text",
  busySelector: 'button[aria-label="Stop response"]',
  notes: "Selectors are best-effort defaults and have not been verified against the live site.",
});

export const CUSTOM_DEFAULTS = base({
  id: "custom",
  name: "My agents",
  purpose: "Agents you build yourself that report in through the API.",
  notes: "Anything you build yourself. Report runs with POST /api/ingest.",
  hidden: true,
});

export const BUILTIN_DEFAULTS: Record<string, PlatformConfig> = {
  chatgpt: CHATGPT_DEFAULTS,
  claude: CLAUDE_DEFAULTS,
  grok: GROK_DEFAULTS,
  gemini: GEMINI_DEFAULTS,
  custom: CUSTOM_DEFAULTS,
};
