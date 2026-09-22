import { bus } from "./bus.js";
import { getSetting, setSetting } from "./db.js";

/*
  Two execution modes, chosen in the chat panel header:
    auto    the agent performs every action on its own
    manual  the agent pauses before an action that changes something on a site
            (sending a message, running a custom action) and waits for Approve / Reject
*/

export type ApprovalMode = "auto" | "manual";
export type Decision = "approved" | "rejected" | "timeout";

export const APPROVAL_TIMEOUT_MS = 15 * 60_000;

export function approvalMode(): ApprovalMode {
  return getSetting("approval_mode") === "manual" ? "manual" : "auto";
}

export function setApprovalMode(mode: ApprovalMode) {
  setSetting("approval_mode", mode);
  bus.emit("settings", { approvalMode: mode });
}

interface Pending {
  action: string;
  summary: string;
  platform: string | null;
  resolve: (d: Decision) => void;
}
const pending = new Map<number, Pending>();

/** Ask the user before an action. Resolves at once in auto mode. */
export function requestApproval(messageId: number, action: string, summary: string, platform: string | null = null): Promise<Decision> {
  if (approvalMode() === "auto") return Promise.resolve("approved");
  pending.get(messageId)?.resolve("rejected");
  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => finish("timeout"), APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    const finish = (d: Decision) => {
      clearTimeout(timer);
      if (pending.get(messageId)?.resolve === finish) pending.delete(messageId);
      resolve(d);
    };
    pending.set(messageId, { action, summary, platform, resolve: finish });
  });
}

/** The user pressed Approve or Reject in the thread. */
export function decide(messageId: number, decision: "approved" | "rejected"): boolean {
  const p = pending.get(messageId);
  if (!p) return false;
  p.resolve(decision);
  return true;
}

export function pendingApproval(messageId: number) {
  const p = pending.get(messageId);
  return p ? { action: p.action, summary: p.summary, platform: p.platform } : null;
}

export function pendingApprovals(): { messageId: number; action: string; summary: string; platform: string | null }[] {
  return [...pending.entries()].map(([messageId, p]) => ({ messageId, action: p.action, summary: p.summary, platform: p.platform }));
}
