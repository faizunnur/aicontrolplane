export type SessionStatus = "logged_in" | "needs_login" | "unknown" | "error";
export type RunStatus = "success" | "failed" | "running" | "needs_attention" | "unknown";
export type AgentSource = "registry" | "discovered" | "push";

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
  /** Deep-link template for a discovered task; {{key}} is replaced with its id. Empty = tasksUrl. */
  nativeUrlTemplate: string;
  /** Text-only fallback: selector of the element whose innerText is snapshotted. */
  snapshotSelector: string;
  /** UI actions runnable from the dashboard; steps may use {{native_url}}, {{key}}, {{name}}, {{tasksUrl}}. */
  actions: Record<string, PlatformActionDef>;
  /** Shown on the dashboard card. */
  notes: string;
}
