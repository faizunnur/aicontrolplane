export type SessionStatus = "logged_in" | "needs_login" | "unknown" | "error";
export type RunStatus = "success" | "failed" | "running" | "needs_attention" | "unknown";
export type AgentSource = "registry" | "discovered" | "push";

export type DeliveryMode = "auto" | "inbox" | "webhook" | "browser" | "manual" | "chat";

/** How instructions reach an agent. Stored as JSON on the agent row. */
export interface AgentDelivery {
  mode: DeliveryMode;
  /** webhook mode: where to POST the instruction. */
  webhook_url?: string;
  /** webhook mode: optional bearer token sent with the POST. */
  webhook_token?: string;
  /** browser mode: platform action to run; defaults to "send_message". */
  action?: string;
}

export interface Agent {
  id: number;
  platform: string;
  key: string;
  name: string;
  source: AgentSource;
  purpose: string | null;
  schedule: string | null;
  native_url: string | null;
  status: string | null;
  enabled: number;
  meta: string | null;
  /** Comma separated hints used by the router, e.g. "market, stocks, morning". */
  keywords: string | null;
  /** JSON AgentDelivery. */
  delivery: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageStatus = "needs_assignment" | "assigned" | "delivered" | "acknowledged" | "done" | "failed";

export interface Suggestion {
  agent_id: number;
  key: string;
  name: string;
  platform: string;
  /** 0..1 */
  score: number;
  reason: string;
}

export interface MessageRow {
  id: number;
  text: string;
  status: MessageStatus;
  /** Target AI (platform id) when the instruction was sent to a connection's chat. */
  platform: string | null;
  agent_id: number | null;
  /** JSON Suggestion[] */
  suggestions: string | null;
  /** JSON routing details: method, confidence, reason, new_agent, llm_error */
  routing: string | null;
  delivery_mode: DeliveryMode | null;
  delivered_at: string | null;
  acked_at: string | null;
  response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: number;
  agent_id: number;
  external_id: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  details: string | null;
  output_url: string | null;
  source: string;
  raw: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  platform: string | null;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read: number;
  occurred_at: string;
  created_at: string;
  dedupe_key: string | null;
}

export interface PlatformState {
  platform: string;
  session_status: SessionStatus;
  last_sync_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  screenshot_path: string | null;
  meta: string | null;
}

export interface ActionStep {
  type: "goto" | "click" | "fill" | "press" | "wait" | "waitFor";
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  ms?: number;
}

export interface PlatformActionDef {
  label?: string;
  description?: string;
  steps: ActionStep[];
}

export interface PlatformConfig {
  id: string;
  name: string;
  /** Home page of the web app; used for session checks and as the VNC landing page. */
  appUrl: string;
  /** Page that lists scheduled tasks / bots / routines. Empty = registry-only platform. */
  tasksUrl: string;
  /** Regex sources. JSON/XHR responses whose URL matches any of these are captured. */
  capturePatterns: string[];
  /** Regex sources. If the final URL after navigation matches, the session needs login. */
  loginUrlPatterns: string[];
  /** Cookie name whose absence means "needs login". Empty = skip cookie check. */
  sessionCookie: string;
  /** Domain the session cookie lives on. */
  cookieDomain: string;
  /** Optional CSS/text selector that only exists when logged in. */
  loggedInSelector: string;
  /** Optional selector of a visible "Log in" / "Sign up" control that only exists when logged out. */
  loggedOutSelector: string;
  /** Deep-link template for a discovered task; {{key}} is replaced with its id. Empty = tasksUrl. */
  nativeUrlTemplate: string;
  /** Text-only fallback: selector of the element whose innerText is snapshotted. */
  snapshotSelector: string;
  /** UI actions runnable from the dashboard; steps may use {{native_url}}, {{key}}, {{name}}, {{tasksUrl}}. */
  actions: Record<string, PlatformActionDef>;
  /** Shown on the dashboard card. */
  notes: string;
  /** One line: what you use this AI for. The router reads it. */
  purpose: string;
  /** Where a fresh conversation starts. Empty = appUrl. */
  chatUrl: string;
  /** The message box on a conversation page. */
  composerSelector: string;
  /** Send button. Empty = press Enter in the composer. */
  sendSelector: string;
  /** Elements holding the AI's replies; the last one is read back. */
  replySelector: string;
  /** Present while the AI is still generating (usually a Stop button). */
  busySelector: string;
  /** Hidden from the Connect list (for built-ins the user removed). */
  hidden: boolean;
}
