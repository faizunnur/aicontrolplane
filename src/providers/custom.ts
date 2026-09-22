import type { PlatformConfig, SessionStatus } from "../types.js";
import {
  UnsupportedOperationError,
  type ActionResult,
  type CapabilityNotes,
  type ChatResult,
  type ConnectionStatus,
  type ExecutionContext,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderKind,
  type ProviderOperation,
  type RunTaskInput,
  type RunTaskResult,
  type TaskListResult,
  type TaskRef,
} from "./types.js";

/**
 * Your own agents. They have no website to drive: they register tasks and report runs through
 * POST /api/ingest, pull instructions from /api/inbox, and (for those with a webhook) receive
 * instructions and "run now" requests pushed to them. A run started through a webhook stays open
 * until the agent reports back on it.
 */
export class CustomProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = "custom";
  readonly builtin = true;

  constructor(
    readonly id: string,
    private readonly cfg: () => PlatformConfig,
  ) {}

  get name() {
    return this.cfg().name;
  }
  get aliases() {
    return ["custom", "my agents", this.cfg().name.toLowerCase()];
  }
  config() {
    return this.cfg();
  }
  capabilities(): ProviderCapabilities {
    return {
      signIn: null,
      checkAuth: null,
      chat: null,
      listTasks: "push",
      getTask: null,
      createTask: "push",
      updateTask: "push",
      cancelTask: null,
      runTask: "api",
      getRun: null,
      subscribeEvents: "push",
      runAction: null,
    };
  }
  capabilityNotes(): CapabilityNotes {
    return {
      signIn: "Your own agents have no website to sign in to.",
      checkAuth: "Your own agents have no session to check; they authenticate to the control plane with the ingest token.",
      chat: "Your own agents do not chat; send them instructions through their inbox or webhook.",
      getTask: "Tasks are whatever your agents registered through POST /api/ingest.",
      cancelTask: "The control plane cannot stop a program it does not run; the agent owns its own lifecycle.",
      runTask: "Only a task whose agent registered a webhook can be started on demand; the agent reports back through /api/runs/:id.",
      getRun: "Runs are what your agents reported; there is nothing more to fetch.",
      runAction: "Your own agents have no browser actions.",
    };
  }
  supports(op: ProviderOperation) {
    return this.capabilities()[op] !== null;
  }
  unsupported(op: ProviderOperation) {
    return new UnsupportedOperationError(this.id, op, this.capabilityNotes()[op] ?? `${this.name} cannot do this.`);
  }
  connectionStatus(): ConnectionStatus {
    return { status: "none", lastCheckedAt: null, lastError: null };
  }
  async connect(): Promise<void> {
    throw this.unsupported("signIn");
  }
  async checkAuth(): Promise<SessionStatus> {
    throw this.unsupported("checkAuth");
  }
  async sendMessage(_text: string, _ctx: ExecutionContext): Promise<ChatResult> {
    throw this.unsupported("chat");
  }
  async listTasks(_ctx: ExecutionContext): Promise<TaskListResult> {
    // Tasks arrive by push; a "list" is what the registry already holds.
    return { ok: true, sessionStatus: "unknown", tasks: [], runs: [], message: "custom agents register their tasks through the ingest API" };
  }

  private webhook(task: TaskRef): { url: string; token: string | null } | null {
    const d = (task.configuration.delivery ?? {}) as { webhook_url?: unknown; webhook_token?: unknown };
    const url = typeof d.webhook_url === "string" && /^https?:\/\//.test(d.webhook_url) ? d.webhook_url : typeof task.configuration.webhook_url === "string" ? (task.configuration.webhook_url as string) : null;
    if (!url) return null;
    const token = typeof d.webhook_token === "string" ? d.webhook_token : typeof task.configuration.webhook_token === "string" ? (task.configuration.webhook_token as string) : null;
    return { url, token };
  }

  canRunTask(task: TaskRef): { ok: boolean; reason?: string } {
    return this.webhook(task) ? { ok: true } : { ok: false, reason: "This task's agent has no webhook. Give the task a delivery webhook_url (Settings › Developer, or the ingest payload's agent.delivery) and it can be started from here." };
  }

  /** Ask the agent to run the task now. The agent reports progress and the outcome through /api/runs/:id. */
  async runTask(task: TaskRef, _ctx: ExecutionContext, input: RunTaskInput = {}): Promise<RunTaskResult> {
    const hook = this.webhook(task);
    if (!hook) return { ok: false, message: this.canRunTask(task).reason ?? "no webhook" };
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(hook.token ? { authorization: `Bearer ${hook.token}` } : {}) },
        body: JSON.stringify({ type: "run_task", run_id: input.run_id ?? null, task: { key: task.key, name: task.name, platform: this.id }, text: input.text ?? null, report_url: input.report_url ?? null }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, message: `the agent's webhook answered ${res.status}` };
      return { ok: true, pending: true, message: `Asked ${task.name}'s agent to run it; waiting for it to report back.` };
    } catch (err) {
      return { ok: false, message: `could not reach the agent's webhook: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async runAction(_action: string, _vars: Record<string, string>, _ctx: ExecutionContext): Promise<ActionResult> {
    throw this.unsupported("runAction");
  }
  outputUrlFor() {
    return null;
  }
}
