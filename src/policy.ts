import { bus } from "./bus.js";
import { addAudit, addEvent, addRunEvent, createApproval, getApproval, getPolicyOverrides, getRun, getSettingCached, listApprovals, setPolicyOverride, setSetting, transitionRun, updateApproval, type ApprovalRow } from "./db.js";
import { logger } from "./logger.js";
import { JOB, queue, type RunResumeJob } from "./queue.js";
import { endRun, finishParked, RunTracker } from "./runs.js";
import type { PolicyMode, Run } from "../packages/core/src/index.js";

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

export async function approvalMode(): Promise<ApprovalPreset> {
  return (await getSettingCached("approval_mode")) === "manual" ? "manual" : "auto";
}
export async function setApprovalMode(mode: ApprovalPreset) {
  await setSetting("approval_mode", mode);
  await addAudit({ actor: "you", action: "policy.preset", detail: mode });
  bus.emit("settings", { approvalMode: mode });
  bus.emit("policy", await listPolicies());
}

/** The effective mode for an action: an explicit override, else the preset's value, never below the floor. Unknown actions ask. */
export async function policyFor(action: string): Promise<{ action: string; mode: PolicyMode; source: "override" | "preset" | "default"; definition: PolicyDefinition }> {
  const def = ACTIONS[action] ?? { label: action, description: "Declared by an agent; not built in.", auto: "ask", manual: "ask", floor: "ask" };
  const override = (await getPolicyOverrides())[action];
  const preset = await approvalMode();
  let mode: PolicyMode = override ?? (preset === "manual" ? def.manual : def.auto);
  if (RANK[mode] < RANK[def.floor]) mode = def.floor;
  return { action, mode, source: override ? "override" : ACTIONS[action] ? "preset" : "default", definition: def };
}

export async function listPolicies() {
  const overrides = await getPolicyOverrides();
  const known = await Promise.all(Object.keys(ACTIONS).map(async (a) => ({ ...(await policyFor(a)), override: overrides[a] ?? null })));
  const extra = await Promise.all(Object.keys(overrides).filter((a) => !ACTIONS[a]).map(async (a) => ({ ...(await policyFor(a)), override: overrides[a] })));
  return { preset: await approvalMode(), policies: [...known, ...extra] };
}

/** Set one action's mode. Cannot go below the action's floor. null restores the preset behaviour. */
export async function setPolicy(action: string, mode: PolicyMode | null) {
  const def = ACTIONS[action];
  if (mode && def && RANK[mode] < RANK[def.floor]) throw Object.assign(new Error(`${def.label} cannot be set below "${def.floor}"`), { status: 400 });
  await setPolicyOverride(action, mode);
  await addAudit({ actor: "you", action: "policy.set", target: action, detail: mode ?? "preset" });
  bus.emit("policy", await listPolicies());
  return await policyFor(action);
}

/* ---------- the gate: park and resume, never wait in memory ---------- */

/** Resume data stored on a parked run: which segment continues, with what inputs. */
export interface Checkpoint {
  step: string;
  inputs?: Record<string, unknown>;
}

export interface GuardScope {
  runId: number;
  messageId?: number | null;
  provider?: string | null;
  /** The run's tracker; the approval appears as its "approve" step. */
  track?: RunTracker | null;
  /** Which resumer continues this run after approval (defaults to the run's kind). */
  kind: string;
  checkpoint: Checkpoint;
}

/**
 * Thrown by guard() when the action needs a human: the run is already parked durably
 * (waiting_approval + checkpoint). Callers unwind, freeing every resource they hold —
 * nothing waits in memory, so a restart loses nothing and any instance can resume.
 */
export class ApprovalPending extends Error {
  constructor(
    readonly approvalId: number,
    readonly runId: number,
  ) {
    super("waiting for approval");
    this.name = "ApprovalPending";
  }
}

/** The segment that continues an approved run, registered per kind by the executing module. */
export type Resumer = (run: Run, approval: ApprovalRow) => Promise<void>;
const resumers = new Map<string, Resumer>();
export function registerResumer(kind: string, fn: Resumer) {
  resumers.set(kind, fn);
}

/**
 * Ask permission for an action. Returns under an "auto" policy; otherwise records the
 * approval, parks the run with its checkpoint, and throws ApprovalPending. The decision —
 * on this instance or any other, before or after a restart — resumes or settles the run.
 */
export async function guard(scope: GuardScope, action: string, summary: string, detail?: string | null): Promise<"approved"> {
  const policy = await policyFor(action);
  if (policy.mode === "auto") {
    await addAudit({ actor: "policy", action: `${action}.auto`, target: `run:${scope.runId}`, detail: summary });
    return "approved";
  }
  const row = await createApproval({ run_id: scope.runId, message_id: scope.messageId ?? null, action, provider: scope.provider ?? null, summary, detail: detail ?? null });
  log.info(`approval #${row.id} requested for ${action} (${policy.mode}): ${summary}`);
  await scope.track?.waiting("approve", summary, detail ?? null);
  await addRunEvent(scope.runId, { type: "approval", label: `Approval requested: ${summary}`, detail: policy.mode === "always" ? "this action always asks" : null, metadata: { approval_id: row.id } });
  await addAudit({ actor: "policy", action: `${action}.requested`, target: `approval:${row.id}`, detail: summary });
  const parked = await transitionRun(scope.runId, ["running"], "waiting_approval", {
    checkpoint: JSON.stringify({ v: 1, kind: scope.kind, step: scope.checkpoint.step, inputs: scope.checkpoint.inputs ?? {} }),
  });
  if (!parked) {
    // The run moved under us (cancelled, most likely). Withdraw the request.
    await updateApproval(row.id, { status: "expired", decided_by: "system", reason: "the run ended before anyone decided" });
    throw new ApprovalPending(row.id, scope.runId);
  }
  throw new ApprovalPending(row.id, scope.runId);
}

/** Record a decision. Returns the row, or null when nothing was pending under that id. */
export async function decide(id: number, decision: "approved" | "rejected", by = "you", reason: string | null = null): Promise<ApprovalRow | null> {
  const a = await getApproval(id);
  if (!a || a.status !== "pending") return null;
  const row = (await updateApproval(id, { status: decision, decided_by: by, reason }))!;
  await addAudit({ actor: by, action: `approval.${decision}`, target: `approval:${id}`, detail: a.summary });
  log.info(`approval #${id} ${decision} by ${by}${reason ? `: ${reason}` : ""}`);
  if (a.run_id) {
    // Resumption is a job: durable in split mode, immediate inline. The decision itself is already recorded.
    await queue.send<RunResumeJob>(JOB.runResume, { runId: a.run_id, approvalId: id, decision: decision === "approved" ? "approved" : "rejected" }, { singletonKey: `resume:${id}` });
  }
  return row;
}

/** Continue or settle a parked run once its approval is decided (or timed out). The run.resume job body. */
export async function settleDecision(runId: number, approvalId: number, decision: Decision): Promise<void> {
  const approval = await getApproval(approvalId);
  if (!approval) return;
  const run = await getRun(runId);
  if (!run || run.status !== "waiting_approval") return; // decided while running (legacy) or already settled
  const track = new RunTracker(run.id, run.message_id);
  if (decision !== "approved") {
    await track.fail("approve", decision === "timeout" ? `no answer in ${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} minutes` : approval.reason ? `rejected: ${approval.reason}` : "rejected");
    await addRunEvent(run.id, { type: "approval", label: decision === "rejected" ? "Rejected" : "Approval expired", metadata: { approval_id: approval.id } });
    await finishParked(run, decision === "timeout" ? "timed_out" : "cancelled", {
      error: decision === "timeout" ? "Nobody approved it within 15 minutes, so it was not done." : "Not done. You rejected it.",
    });
    return;
  }
  await track.done("approve", `approved by ${approval.decided_by ?? "you"}`);
  await addRunEvent(run.id, { type: "approval", label: "Approved", metadata: { approval_id: approval.id } });
  const checkpoint = parseCheckpoint(run.checkpoint);
  const resumer = checkpoint ? resumers.get(checkpoint.kind ?? run.kind) : undefined;
  const claimed = await transitionRun(run.id, ["waiting_approval"], "running", { started_at: run.started_at ?? new Date().toISOString() });
  if (!claimed) return;
  if (!resumer) {
    await endRun(run.id, { status: "needs_attention", error: "Approved, but nothing knows how to continue this run (no resumer registered)." });
    return;
  }
  try {
    await resumer(claimed, approval);
  } catch (err) {
    log.error(`resuming run #${runId} after approval #${approvalId} failed`, err);
    const after = await getRun(runId);
    if (after && after.status === "running") await endRun(runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  }
}

function parseCheckpoint(raw: string | null): { v: number; kind: string; step: string; inputs: Record<string, unknown> } | null {
  try {
    const c = raw ? JSON.parse(raw) : null;
    if (c && c.v === 1 && typeof c.step === "string") return c;
    return null;
  } catch {
    return null;
  }
}

/**
 * Expire approvals nobody decided in time and settle their runs. Runs on a clock (and at
 * boot); replaces the in-memory 15-minute timers, so a pending approval survives restarts.
 */
export async function sweepApprovals(timeoutMs = APPROVAL_TIMEOUT_MS): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const pending = await listApprovals({ status: "pending", limit: 500 });
  let expired = 0;
  for (const a of pending) {
    if (a.requested_at >= cutoff) continue;
    const row = await updateApproval(a.id, { status: "expired", decided_by: "timeout", reason: "no decision in time" });
    if (!row) continue;
    expired++;
    if (a.run_id) {
      await queue.send<RunResumeJob>(JOB.runResume, { runId: a.run_id, approvalId: a.id, decision: "timeout" }, { singletonKey: `resume:${a.id}` });
    }
    await addEvent({ platform: a.provider ?? null, kind: "approval", title: "An approval expired undecided", body: a.summary, dedupe_key: `approval_expired:${a.id}` });
  }
  return expired;
}

/** Decide whatever is pending for a message (the thread's Approve / Reject buttons). */
export async function decideForMessage(messageId: number, decision: "approved" | "rejected", by = "you"): Promise<ApprovalRow | null> {
  const pending = (await listApprovals({ status: "pending", message_id: messageId, limit: 1 }))[0];
  return pending ? await decide(pending.id, decision, by) : null;
}

export async function pendingApprovals(): Promise<ApprovalRow[]> {
  return await listApprovals({ status: "pending", limit: 200 });
}

/**
 * A custom agent asks for permission through the API and polls for the answer. No waiter: the
 * decision lands in the row, and the agent reads it back.
 */
export async function requestExternalApproval(input: { action: string; summary: string; detail?: string | null; provider?: string | null; run_id?: number | null }): Promise<{ approval: ApprovalRow; decision: Decision | "pending" }> {
  const policy = await policyFor(input.action);
  if (policy.mode === "auto") {
    const approval = await createApproval({ ...input, run_id: input.run_id ?? null });
    await updateApproval(approval.id, { status: "approved", decided_by: "policy", reason: "auto" });
    return { approval: (await getApproval(approval.id))!, decision: "approved" };
  }
  const approval = await createApproval({ ...input, run_id: input.run_id ?? null });
  await addAudit({ actor: "agent", action: `${input.action}.requested`, target: `approval:${approval.id}`, detail: input.summary });
  return { approval, decision: "pending" };
}

/* ---------- restart recovery ---------- */

/**
 * Pending approvals are durable now — their runs are parked, not held in memory — so a
 * restart keeps them waiting instead of interrupting them. The one repair needed at boot:
 * an approval whose run died with the process (crash between requesting and parking, or a
 * run the lease recovery just failed) can never be approved into anything, so it is closed.
 * Overdue ones are expired by the same sweep that runs on the clock.
 */
export async function recoverInterruptedApprovals(): Promise<number> {
  let repaired = 0;
  for (const a of await listApprovals({ status: "pending", limit: 500 })) {
    if (!a.run_id) continue;
    const run = await getRun(a.run_id);
    if (run && run.status === "waiting_approval") continue; // parked and healthy: survives the restart
    await updateApproval(a.id, { status: "interrupted", decided_by: "system", reason: "the run ended before anyone decided" });
    await addEvent({ platform: a.provider ?? null, kind: "approval", title: "An approval was interrupted by a restart", body: a.summary, dedupe_key: `approval_interrupted:${a.id}` });
    repaired++;
  }
  const expired = await sweepApprovals();
  if (repaired || expired) log.warn(`approval recovery: ${repaired} interrupted (run gone), ${expired} expired (overdue)`);
  return repaired;
}
