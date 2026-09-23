import { browser } from "../browser/manager.js";
import { getPlatformState, getSetting } from "../db.js";
import type { PlatformConfig, SessionStatus } from "../types.js";
import { runConfiguredAction } from "./browser/actions.js";
import { checkSignIn, sendThroughBrowser } from "./browser/chat.js";
import { detectChallenge } from "./browser/login.js";
import { collectTasks } from "./browser/tasks.js";
import {
  SIGN_IN_MODES,
  UnsupportedOperationError,
  type ActionResult,
  type CapabilityNotes,
  type ChatResult,
  type ConnectionStatus,
  type ConnectResult,
  type ExecutionContext,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderKind,
  type ProviderOperation,
  type RunTaskInput,
  type RunTaskResult,
  type SignInMode,
  type TaskListResult,
  type TaskRef,
} from "./types.js";

/**
 * A provider driven through its website in the cloud browser. Everything is decided by the
 * provider's configuration (URLs and selectors), so a provider the user adds by hand works
 * the same way as a built-in one. Built-ins subclass this to add aliases, verified capability
 * notes, and the few rules that are specific to one site.
 */
export class BrowserProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = "browser";

  constructor(
    readonly id: string,
    /** Always read live, so edits in Settings apply without rebuilding the registry. */
    protected readonly cfg: () => PlatformConfig,
    readonly builtin = false,
  ) {}

  get name() {
    return this.cfg().name;
  }

  get aliases(): string[] {
    const c = this.cfg();
    return [...new Set([c.id.toLowerCase(), c.name.toLowerCase(), ...this.extraAliases()].filter(Boolean))];
  }
  protected extraAliases(): string[] {
    return [];
  }

  config() {
    return this.cfg();
  }

  capabilities(): ProviderCapabilities {
    const c = this.cfg();
    const site = !!c.appUrl;
    return {
      signIn: site ? "browser" : null,
      checkAuth: site ? "browser" : null,
      chat: site && c.composerSelector ? "browser" : null,
      listTasks: site && c.tasksUrl ? "browser" : null,
      getTask: null,
      createTask: null,
      updateTask: null,
      cancelTask: null,
      runTask: null,
      getRun: null,
      subscribeEvents: null,
      runAction: site && Object.keys(c.actions ?? {}).some((k) => k !== "send_message") ? "browser" : null,
      ...this.extraCapabilities(),
    };
  }
  protected extraCapabilities(): Partial<ProviderCapabilities> {
    return {};
  }

  capabilityNotes(): CapabilityNotes {
    const c = this.cfg();
    const n = c.name;
    return {
      signIn: c.appUrl ? undefined : `${n} has no web address to sign in to.`,
      chat: c.composerSelector ? undefined : `${n} has no message box selector configured.`,
      listTasks: c.tasksUrl ? undefined : `${n} has no tasks page configured. Add its address in AI setup and the control plane reads it through the browser.`,
      getTask: `${n} offers no way to fetch one task; the registry keeps what the last look at its tasks page found.`,
      createTask: `${n} has no API for creating tasks; create them on its site.`,
      updateTask: `${n} has no API for changing tasks; change them on its site.`,
      cancelTask: `${n} has no API for cancelling tasks; cancel them on its site.`,
      runTask: `${n} has no API for starting a task on demand.`,
      getRun: `${n} has no API for reading a run; open the run on its site.`,
      subscribeEvents: `${n} does not push events; the control plane looks at its tasks page on a schedule.`,
      runAction: `${n} has no browser actions configured.`,
      ...this.extraNotes(),
    };
  }
  protected extraNotes(): CapabilityNotes {
    return {};
  }

  supports(op: ProviderOperation): boolean {
    return this.capabilities()[op] !== null;
  }

  unsupported(op: ProviderOperation): UnsupportedOperationError {
    return new UnsupportedOperationError(this.id, op, this.capabilityNotes()[op] ?? `${this.name} cannot do this.`);
  }
  protected require(op: ProviderOperation) {
    if (!this.supports(op)) throw this.unsupported(op);
  }

  connectionStatus(): ConnectionStatus {
    const s = getPlatformState(this.id);
    return { status: this.cfg().appUrl ? s.session_status : "none", lastCheckedAt: s.last_sync_at, lastError: s.last_error };
  }

  async connect(): Promise<ConnectResult> {
    this.require("signIn");
    const c = this.cfg();
    return browser.withLock(
      async () => {
        const page = await browser.consolePage(c.id, c.appUrl);
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500); // a bot check renders after load
        return detectChallenge(page);
      },
      { label: `Opening ${c.name}`, platform: c.id },
    );
  }

  /** What worked last time wins; otherwise what the provider is known to need; otherwise the live view. */
  preferredSignIn(): SignInMode {
    const remembered = getSetting(`signin_mode:${this.id}`);
    if (remembered && (SIGN_IN_MODES as readonly string[]).includes(remembered)) return remembered as SignInMode;
    return this.defaultSignIn();
  }
  protected defaultSignIn(): SignInMode {
    return "live";
  }

  async checkAuth(): Promise<SessionStatus> {
    this.require("checkAuth");
    return checkSignIn(this.cfg());
  }

  async sendMessage(text: string, ctx: ExecutionContext): Promise<ChatResult> {
    this.require("chat");
    return sendThroughBrowser(this.cfg(), text, ctx.track);
  }

  async listTasks(ctx: ExecutionContext): Promise<TaskListResult> {
    this.require("listTasks");
    return collectTasks(this.cfg(), (raw) => this.outputUrlFor(raw), ctx);
  }

  async runTask(_task: TaskRef, _ctx: ExecutionContext, _input?: RunTaskInput): Promise<RunTaskResult> {
    throw this.unsupported("runTask");
  }

  canRunTask(_task: TaskRef): { ok: boolean; reason?: string } {
    return this.supports("runTask") ? { ok: true } : { ok: false, reason: this.capabilityNotes().runTask ?? `${this.name} cannot start a task on demand.` };
  }

  async runAction(action: string, vars: Record<string, string>, ctx: ExecutionContext): Promise<ActionResult> {
    this.require("runAction");
    return runConfiguredAction(this.cfg(), action, vars, ctx);
  }

  outputUrlFor(_raw: Record<string, unknown>): string | null {
    return null;
  }
}
