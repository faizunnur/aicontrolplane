export type SessionStatus = "logged_in" | "needs_login" | "unknown" | "error";
export type RunStatus = "success" | "failed" | "running" | "needs_attention" | "cancelled" | "unknown";
export type TaskSource = "registry" | "discovered" | "push";
/** @deprecated the registry stored tasks under the name "agents"; use TaskSource. */
export type AgentSource = TaskSource;

/**
 * What a run is:
 *   chat        a message sent to a provider's assistant and its answer
 *   dispatch    a message handed to a registered task's agent (inbox, webhook or browser action)
 *   sync        a look at a provider's tasks page
 *   action      a browser action started from the control plane
 *   task        a task the control plane started at the provider (runTask)
 *   external    reported by a custom agent through the ingest API
 *   discovered  captured from a provider's own run history
 *   email       read from a provider's notification email
 */
export type RunKind = "chat" | "dispatch" | "sync" | "action" | "task" | "external" | "discovered" | "email";
export type RunTrigger = "user" | "schedule" | "push" | "system";

export type RunEventType = "step" | "log" | "approval" | "result" | "error";

/** auto: goes ahead. ask: waits for you. always: waits for you and cannot be relaxed. */
export type PolicyMode = "auto" | "ask" | "always";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "interrupted";

/** A request to do something that policy says you must approve. Persisted, so a restart cannot lose it quietly. */
export interface Approval {
  id: number;
  run_id: number | null;
  message_id: number | null;
  action: string;
  provider: string | null;
  summary: string;
  detail: string | null;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  metadata: string | null;
}

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

/**
 * A standing piece of work at a provider: a ChatGPT scheduled task, a Claude Code routine, a Grok
 * automation, a custom agent's job. Identified by (platform, key), where key is the provider's own id.
 */
export interface Task {
  id: number;
  /** Provider id ("chatgpt", "claude", "custom", …). */
  platform: string;
  key: string;
  name: string;
  source: TaskSource;
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
  /** The agent profile that carries this task out; null until one is attached. */
  agent_id: number | null;
  /** The standing instruction the task runs with, when known. */
  prompt: string | null;
  /** When the provider says it runs next, ISO, when known. */
  next_run: string | null;
  /** JSON, provider-specific settings for the task: a routine's fire URL and token, a webhook, … */
  configuration: string | null;
  created_at: string;
  updated_at: string;
}
/** @deprecated use Task. */
export type Agent = Task;

/** Who does the work: a provider's built-in assistant, or a program of your own. */
export interface AgentProfile {
  id: number;
  key: string;
  name: string;
  description: string | null;
  provider_id: string | null;
  /** assistant (the provider's own AI) | custom (your program) | system (the control plane itself) */
  kind: "assistant" | "custom" | "system";
  /** JSON string[] of what it can do, as declared by the provider or the agent. */
  capabilities: string | null;
  status: "active" | "paused" | "disabled";
  /** JSON, agent-specific settings. */
  configuration: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageStatus = "needs_assignment" | "assigned" | "delivered" | "acknowledged" | "done" | "failed" | "cancelled";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "waiting";

/** One line of agent activity shown under a message: "Opening ChatGPT", "Waiting for your approval", … */
export interface Step {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string | null;
  at: string;
  ended_at?: string | null;
}

export interface Conversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

export interface Suggestion {
  task_id: number;
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
  /** Target provider id when the message was sent to a provider's chat. */
  platform: string | null;
  /** Registered task the message was handed to (developer API), if any. */
  task_id: number | null;
  conversation_id: number | null;
  /** The run that carried this message out. A message is never a run; it points at one. */
  run_id: number | null;
  /** JSON Step[]: mirror of the run's step events, kept for the current UI. run_events is the source of truth. */
  steps: string | null;
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

/** One execution: of a task, of a message, of a sync, of an action. Every kind of work leaves one. */
export interface Run {
  id: number;
  task_id: number | null;
  agent_id: number | null;
  /** Provider id the run executed on, if any. */
  provider: string | null;
  kind: RunKind;
  trigger: RunTrigger | null;
  /** Message that started the run, for chat and dispatch runs. */
  message_id: number | null;
  /** Short human title: "Message to ChatGPT", "Weekly research", "Looking at Claude's routines". */
  label: string | null;
  external_id: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  details: string | null;
  output_url: string | null;
  error: string | null;
  source: string;
  raw: string | null;
  created_at: string;
}

/** One line of a run's timeline. Steps are events with a key and a status; the latest event per key is the step's state. */
export interface RunEvent {
  id: number;
  run_id: number;
  at: string;
  type: RunEventType;
  key: string | null;
  label: string;
  status: StepStatus | null;
  detail: string | null;
  metadata: string | null;
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
