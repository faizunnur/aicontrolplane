import { bus } from "./bus.js";
import { addAudit, addEvent, addRunEvent, createApproval, getApproval, getPolicyOverrides, getRun, getSetting, listApprovals, setPolicyOverride, setSetting, updateApproval, updateMessage, type ApprovalRow } from "./db.js";
import { logger } from "./logger.js";
import { endRun, type RunTracker } from "./runs.js";
import type { PolicyMode } from "./types.js";

const log = logger("policy");

/*
  Approval is a policy decided and enforced here, on the server. Execution code never decides
  whether it may act; it calls guard() with the action it is about to take and continues only
  when guard says so. Every request is a row in `approvals`, so a restart cannot lose one quietly:
  on boot, anything still pending is marked interrupted and its run is surfaced as needing you.

  Two presets drive the switch in the chat header:
    auto    the agent acts on its own for everyday actions
    manual  the agent asks first for everyday actions
  Some actions always ask, whatever the preset, and cannot be relaxed.
*/

export interface PolicyDefinition {
  label: string;
  description: string;
  /** Mode under the "auto" preset. */
  auto: PolicyMode;
  /** Mode under the "manual" preset. */
  manual: PolicyMode;
  /** The most permissive mode an override may set. */
  floor: PolicyMode;
}

export const ACTIONS: Record<string, PolicyDefinition> = {
  read_page: { label: "Read a page", description: "Open and read a page in the browser.", auto: "auto", manual: "auto", floor: "auto" },
  search: { label: "Search", description: "Search the web or a site.", auto: "auto", manual: "auto", floor: "auto" },
  screenshot: { label: "Take a screenshot", description: "Capture a provider's tab.", auto: "auto", manual: "auto", floor: "auto" },
  sync: { label: "Look at a provider's tasks", description: "Visit a provider's tasks page and read what it shows.", auto: "auto", manual: "auto", floor: "auto" },
  send_message: { label: "Send a message to an AI", description: "Type and send a message in a provider's chat.", auto: "auto", manual: "ask", floor: "auto" },
  run_action: { label: "Run a browser action", description: "Run a configured sequence of clicks and inputs on a provider's site.", auto: "auto", manual: "ask", floor: "auto" },
  run_task: { label: "Start a task at a provider", description: "Trigger a task to run now (a routine's API trigger, an agent's webhook).", auto: "auto", manual: "ask", floor: "auto" },
  dispatch_webhook: { label: "Send an instruction to your agent", description: "Post an instruction to one of your own agents.", auto: "auto", manual: "ask", floor: "auto" },
  modify_repository: { label: "Modify a repository", description: "Push commits, open or merge pull requests.", auto: "ask", manual: "ask", floor: "ask" },
  deploy_production: { label: "Deploy to production", description: "Ship something to a live environment.", auto: "always", manual: "always", floor: "always" },
  delete_resource: { label: "Delete a resource", description: "Remove data, infrastructure or accounts.", auto: "always", manual: "always", floor: "always" },
};

const RANK: Record<PolicyMode, number> = { auto: 0, ask: 1, always: 2 };
export type ApprovalPreset = "auto" | "manual";
export type Decision = "approved" | "rejected" | "timeout";
export const APPROVAL_TIMEOUT_MS = 15 * 60_000;

export function approvalMode(): ApprovalPreset {
  return getSetting("approval_mode") === "manual" ? "manual" : "auto";
}
export function setApprovalMode(mode: ApprovalPreset) {
  setSetting("approval_mode", mode);
  addAudit({ actor: "you", action: "policy.preset", detail: mode });
  bus.emit("settings", { approvalMode: mode });
  bus.emit("policy", listPolicies());
}

/** The effective mode for an action: an explicit override, else the preset's value, never below the floor. Unknown actions ask. */
export function policyFor(action: string): { action: string; mode: PolicyMode; source: "override" | "preset" | "default"; definition: PolicyDefinition } {
  const def = ACTIONS[action] ?? { label: action, description: "Declared by an agent; not built in.", auto: "ask", manual: "ask", floor: "ask" };
  const override = getPolicyOverrides()[action];
  const preset = approvalMode();
  let mode: PolicyMode = override ?? (preset === "manual" ? def.manual : def.auto);
  if (RANK[mode] < RANK[def.floor]) mode = def.floor;
  return { action, mode, source: override ? "override" : ACTIONS[action] ? "preset" : "default", definition: def };
}

export function listPolicies() {
  const overrides = getPolicyOverrides();
  const known = Object.keys(ACTIONS).map((a) => ({ ...policyFor(a), override: overrides[a] ?? null }));
  const extra = Object.keys(overrides).filter((a) => !ACTIONS[a]).map((a) => ({ ...policyFor(a), override: overrides[a] }));
  return { preset: approvalMode(), policies: [...known, ...extra] };
}

/** Set one action's mode. Cannot go below the action's floor. null restores the preset behaviour. */
export function setPolicy(action: string, mode: PolicyMode | null) {
  const def = ACTIONS[action];
  if (mode && def && RANK[mode] < RANK[def.floor]) throw Object.assign(new Error(`${def.label} cannot be set below "${def.floor}"`), { status: 400 });
  setPolicyOverride(action, mode);
  addAudit({ actor: "you", action: "policy.set", target: action, detail: mode ?? "preset" });
  bus.emit("policy", listPolicies());
  return policyFor(action);
}

/* ---------- the gate ---------- */

export interface GuardScope {
  runId?: number | null;
  messageId?: number | null;
  provider?: string | null;
  /** The run's tracker; the approval appears as its "approve" step. */
  track?: RunTracker | null;
}

const waiters = new Map<number, (d: Decision) => void>();

/**
 * Ask permission for an action. Returns at once under an "auto" policy; otherwise records an
 * approval, shows it in the run's timeline, and waits for a decision or the timeout.
 */
export async function guard(scope: GuardScope, action: string, summary: string, detail?: string | null, opts: { timeoutMs?: number } = {}): Promise<Decision> {
  const policy = policyFor(action);
  if (policy.mode === "auto") {
    addAudit({ actor: "policy", action: `${action}.auto`, target: scope.runId ? `run:${scope.runId}` : null, detail: summary });
    return "approved";
  }
  const row = createApproval({ run_id: scope.runId ?? null, message_id: scope.messageId ?? null, action, provider: scope.provider ?? null, summary, detail: detail ?? null });
  log.info(`approval #${row.id} requested for ${action} (${policy.mode}): ${summary}`);
  scope.track?.waiting("approve", summary, detail ?? null);
  if (scope.runId) addRunEvent(scope.runId, { type: "approval", label: `Approval requested: ${summary}`, detail: policy.mode === "always" ? "this action always asks" : null, metadata: { approval_id: row.id } });
  addAudit({ actor: "policy", action: `${action}.requested`, target: `approval:${row.id}`, detail: summary });
  const decision = await waitForDecision(row.id, opts.timeoutMs ?? APPROVAL_TIMEOUT_MS);
  if (decision === "timeout") {
    updateApproval(row.id, { status: "expired", decided_by: "timeout", reason: "no decision in time" });
    scope.track?.fail("approve", `no answer in ${Math.round((opts.timeoutMs ?? APPROVAL_TIMEOUT_MS) / 60_000)} minutes`);
  } else {
    const after = getApproval(row.id);
    if (decision === "approved") scope.track?.done("approve", `approved by ${after?.decided_by ?? "you"}`);
    else scope.track?.fail("approve", after?.reason ? `rejected: ${after.reason}` : "rejected");
  }
  if (scope.runId) addRunEvent(scope.runId, { type: "approval", label: decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Approval expired", metadata: { approval_id: row.id } });
  return decision;
}

function waitForDecision(id: number, timeoutMs: number): Promise<Decision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref?.();
    const finish = (d: Decision) => {
      clearTimeout(timer);
      if (waiters.get(id) === finish) waiters.delete(id);
      resolve(d);
    };
    waiters.set(id, finish);
  });
}

/** Record a decision. Returns the row, or null when nothing was pending under that id. */
export function decide(id: number, decision: "approved" | "rejected", by = "you", reason: string | null = null): ApprovalRow | null {
  const a = getApproval(id);
  if (!a || a.status !== "pending") return null;
  const row = updateApproval(id, { status: decision, decided_by: by, reason })!;
  addAudit({ actor: by, action: `approval.${decision}`, target: `approval:${id}`, detail: a.summary });
  log.info(`approval #${id} ${decision} by ${by}${reason ? `: ${reason}` : ""}`);
  waiters.get(id)?.(decision);
  return row;
}

/** Decide whatever is pending for a message (the thread's Approve / Reject buttons). */
export function decideForMessage(messageId: number, decision: "approved" | "rejected", by = "you"): ApprovalRow | null {
  const pending = listApprovals({ status: "pending", message_id: messageId, limit: 1 })[0];
  return pending ? decide(pending.id, decision, by) : null;
}

export function pendingApprovals(): ApprovalRow[] {
  return listApprovals({ status: "pending", limit: 200 });
}

/**
 * A custom agent asks for permission through the API and polls for the answer. No waiter: the
 * decision lands in the row, and the agent reads it back.
 */
export function requestExternalApproval(input: { action: string; summary: string; detail?: string | null; provider?: string | null; run_id?: number | null }): { approval: ApprovalRow; decision: Decision | "pending" } {
  const policy = policyFor(input.action);
  if (policy.mode === "auto") {
    const approval = createApproval({ ...input, run_id: input.run_id ?? null });
    updateApproval(approval.id, { status: "approved", decided_by: "policy", reason: "auto" });
    return { approval: getApproval(approval.id)!, decision: "approved" };
  }
  const approval = createApproval({ ...input, run_id: input.run_id ?? null });
  addAudit({ actor: "agent", action: `${input.action}.requested`, target: `approval:${approval.id}`, detail: input.summary });
  return { approval, decision: "pending" };
}

/* ---------- restart recovery ---------- */

/** Anything that was waiting for you when the server stopped is surfaced, not dropped. */
export function recoverInterruptedApprovals(): number {
  const pending = listApprovals({ status: "pending", limit: 500 });
  for (const a of pending) {
    updateApproval(a.id, { status: "interrupted", decided_by: "system", reason: "the server restarted while this was waiting for approval" });
    const error = "The server restarted while this was waiting for your approval. Nothing was sent; run it again if you still want it.";
    if (a.run_id) {
      const run = getRun(a.run_id);
      if (run && run.status === "running") {
        addRunEvent(run.id, { type: "step", key: "approve", label: a.summary, status: "failed", detail: "interrupted by a restart" });
        endRun(run.id, { status: "needs_attention", error });
      }
    }
    if (a.message_id) updateMessage(a.message_id, { status: "failed", error });
    addEvent({ platform: a.provider ?? null, kind: "approval", title: "An approval was interrupted by a restart", body: a.summary, dedupe_key: `approval_interrupted:${a.id}` });
  }
  if (pending.length) log.warn(`${pending.length} approval(s) were pending across the restart; marked interrupted and surfaced`);
  return pending.length;
}
