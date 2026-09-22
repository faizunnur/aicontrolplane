import type { RunTracker } from "../runs.js";
import type { PlatformConfig, RunStatus, RunTrigger, SessionStatus } from "../types.js";

/*
  Providers are execution backends: ChatGPT, Claude, Grok, Gemini, your own agents.
  Everything provider-specific lives behind this interface. The rest of the control plane
  asks an adapter what it can do and calls only the operations it supports.

  Which backend implements an operation is declared, per provider, in its capabilities.
  A null backend means "this provider cannot do that"; the API answers with a structured
  unsupported-operation error and the UI hides the control. Nothing is faked.
*/

export type Backend = "browser" | "api" | "mcp" | "push";
export type ProviderKind = "browser" | "api" | "hybrid" | "custom";

export type ProviderOperation =
  | "signIn" // interactive sign-in in the live browser
  | "checkAuth" // are we signed in?
  | "chat" // send a message and read the reply
  | "listTasks" // enumerate the provider's scheduled / standing tasks
  | "getTask"
  | "createTask"
  | "updateTask"
  | "cancelTask"
  | "runTask" // start a task now
  | "getRun" // read one run's state / output
  | "subscribeEvents" // push updates (webhooks or a stream) from the provider
  | "runAction"; // provider-defined browser action (steps in its config)

export type ProviderCapabilities = Record<ProviderOperation, Backend | null>;

/** Why an operation is unsupported, in one sentence for the UI. Verified facts only. */
export type CapabilityNotes = Partial<Record<ProviderOperation, string>>;

export interface ConnectionStatus {
  /** logged_in | needs_login | error | unknown, or "none" when the provider has no site to sign in to. */
  status: SessionStatus | "none";
  lastCheckedAt: string | null;
  lastError: string | null;
}

/** What an execution carries with it so the adapter can report progress and honour approvals. */
export interface ExecutionContext {
  /** Message that triggered the execution, when it came from the chat. */
  messageId?: number;
  /** Run the execution belongs to. Callers that have none get one created for them. */
  runId?: number;
  /** Step reporter for the run; adapters call start/done/fail on it as they go. */
  track?: RunTracker;
  /** What started the work, for runs created on the caller's behalf. */
  trigger?: RunTrigger;
}

export interface ChatResult {
  ok: boolean;
  reply?: string;
  partial?: boolean;
  url?: string;
  error?: string;
  /** The user stopped it or did not approve it. */
  cancelled?: boolean;
}

export interface ProviderTask {
  /** Provider's own id for the task. */
  key: string;
  name: string;
  schedule: string | null;
  next_run?: string | null;
  status: string | null;
  native_url: string | null;
  purpose: string | null;
  raw?: unknown;
}

export interface ProviderRun {
  taskKey: string;
  external_id: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  output_url: string | null;
  raw?: unknown;
}

export interface TaskListResult {
  ok: boolean;
  sessionStatus: SessionStatus;
  tasks: ProviderTask[];
  runs: ProviderRun[];
  /** Backend-specific diagnostics (captured payloads, final url, …). */
  meta?: Record<string, unknown>;
  message?: string;
}

export interface ActionResult {
  ok: boolean;
  action: string;
  message: string;
  url?: string;
  screenshot?: boolean;
}

/** What an adapter needs to know about a task to start it at the provider. */
export interface TaskRef {
  id: number;
  key: string;
  name: string;
  /** Per-task settings (a routine's fire URL and token, a webhook, …). */
  configuration: Record<string, unknown>;
}

export interface RunTaskResult {
  ok: boolean;
  /** The provider's id for the run it started, when it gives one. */
  external_id?: string | null;
  /** Where to watch the run at the provider, when it gives one. */
  url?: string | null;
  message: string;
  /** True when the work continues elsewhere and the outcome arrives later (an agent's callback). */
  pending?: boolean;
}

export interface RunTaskInput {
  /** Run-specific text passed along with the task's standing prompt, when the provider accepts one. */
  text?: string;
  /** Where the provider or agent can report back about this run. */
  report_url?: string | null;
  run_id?: number;
}

export class UnsupportedOperationError extends Error {
  readonly status = 501;
  constructor(
    readonly provider: string,
    readonly operation: ProviderOperation,
    readonly reason: string,
  ) {
    super(`${provider} does not support ${operation}: ${reason}`);
    this.name = "UnsupportedOperationError";
  }
  toJSON() {
    return { error: "unsupported_operation", provider: this.provider, operation: this.operation, reason: this.reason };
  }
}

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  /** Ships with the app (ChatGPT, Claude, Grok, Gemini, custom agents) rather than added by the user. */
  readonly builtin: boolean;
  /** Names the router recognises in a message ("ask Grok…"). Lower case. */
  readonly aliases: string[];

  /** The effective configuration (built-in defaults merged with the user's overrides). */
  config(): PlatformConfig;
  capabilities(): ProviderCapabilities;
  capabilityNotes(): CapabilityNotes;
  supports(op: ProviderOperation): boolean;
  connectionStatus(): ConnectionStatus;

  /** Bring the provider's site up in its tab so the user can sign in through the live view. */
  connect(ctx?: ExecutionContext): Promise<void>;
  checkAuth(ctx?: ExecutionContext): Promise<SessionStatus>;
  sendMessage(text: string, ctx: ExecutionContext): Promise<ChatResult>;
  listTasks(ctx: ExecutionContext): Promise<TaskListResult>;
  runTask(task: TaskRef, ctx: ExecutionContext, input?: RunTaskInput): Promise<RunTaskResult>;
  /** Whether this particular task can be started now, given its configuration. */
  canRunTask(task: TaskRef): { ok: boolean; reason?: string };
  runAction(action: string, vars: Record<string, string>, ctx: ExecutionContext): Promise<ActionResult>;
  /** Structured error for an operation this provider cannot do. */
  unsupported(op: ProviderOperation): UnsupportedOperationError;

  /** Hook for the task normaliser: where a captured run's output lives, if the provider has a rule. */
  outputUrlFor(raw: Record<string, unknown>): string | null;
}
