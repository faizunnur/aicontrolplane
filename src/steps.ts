import { getMessage, now, updateMessage } from "./db.js";
import type { Step, StepStatus } from "./types.js";

/*
  Agent activity for one message, shown live in the chat panel:
    Choosing the AI → Opening ChatGPT → Typing your message → (Waiting for your approval) → Sending → Waiting for the answer → Reading the answer → Done
  Every change is written to the message row, which announces itself on the bus.
*/

const cancelRequested = new Set<number>();

export function requestCancel(messageId: number) {
  cancelRequested.add(messageId);
}
export function isCancelled(messageId: number) {
  return cancelRequested.has(messageId);
}
export function clearCancel(messageId: number) {
  cancelRequested.delete(messageId);
}

export class CancelledError extends Error {
  constructor(message = "You stopped it.") {
    super(message);
    this.name = "CancelledError";
  }
}

export class StepTracker {
  constructor(readonly messageId: number) {}

  read(): Step[] {
    const m = getMessage(this.messageId);
    try {
      return m?.steps ? (JSON.parse(m.steps) as Step[]) : [];
    } catch {
      return [];
    }
  }

  private write(steps: Step[]) {
    updateMessage(this.messageId, { steps });
  }

  clear() {
    this.write([]);
  }

  set(key: string, label: string, status: StepStatus, detail?: string | null) {
    const steps = this.read();
    const ts = now();
    const finished = status === "done" || status === "failed" || status === "skipped";
    const i = steps.findIndex((s) => s.key === key);
    if (i >= 0) {
      const cur = steps[i];
      steps[i] = {
        ...cur,
        label: label || cur.label,
        status,
        detail: detail === undefined ? cur.detail : detail,
        at: status === "running" && cur.status !== "running" ? ts : cur.at,
        ended_at: finished ? ts : null,
      };
    } else {
      steps.push({ key, label, status, detail: detail ?? null, at: ts, ended_at: finished ? ts : null });
    }
    this.write(steps);
  }

  /** Begin a step. Throws CancelledError if the user pressed Stop, so callers unwind naturally. */
  start(key: string, label: string, detail?: string | null) {
    this.checkCancel();
    this.set(key, label, "running", detail);
  }
  done(key: string, detail?: string | null) {
    this.set(key, "", "done", detail);
  }
  fail(key: string, detail?: string | null) {
    this.set(key, "", "failed", detail);
  }
  skip(key: string, detail?: string | null) {
    this.set(key, "", "skipped", detail);
  }
  waiting(key: string, label: string, detail?: string | null) {
    this.set(key, label, "waiting", detail);
  }

  /** Whatever is still running or waiting failed with this reason. */
  failRunning(detail: string) {
    const steps = this.read();
    let changed = false;
    for (const s of steps) {
      if (s.status === "running" || s.status === "waiting" || s.status === "pending") {
        s.status = "failed";
        s.detail = detail;
        s.ended_at = now();
        changed = true;
      }
    }
    if (changed) this.write(steps);
  }

  checkCancel() {
    if (isCancelled(this.messageId)) throw new CancelledError();
  }
}
