import fs from "node:fs";
import { getTask, getPlatformState, listTasks, type MessageWithTask } from "./db.js";
import { describeMode, resolveMode } from "./deliver.js";
import { getProvider } from "./providers/registry.js";
import type { PlatformConfig } from "./types.js";

/* Shapes the UI renders. Shared by the REST routes and the live stream so both agree. */

function parse(s: string | null) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** Expand JSON columns and add a human hint so the UI can render a message without extra calls. */
export function expandMessage(m: MessageWithTask) {
  const agent = m.task_id ? getTask(m.task_id) : undefined;
  const mode = m.delivery_mode ?? (agent ? resolveMode(agent) : null);
  return {
    ...m,
    suggestions: parse(m.suggestions) ?? [],
    routing: parse(m.routing),
    steps: parse(m.steps) ?? [],
    delivery_mode: mode,
    delivery_hint: mode ? describeMode(mode) : null,
  };
}
export type ExpandedMessage = ReturnType<typeof expandMessage>;

/** One AI as the sidebar and the Activity view show it. */
export function connectionCard(p: PlatformConfig) {
  const s = getPlatformState(p.id);
  const tasks = listTasks({ platform: p.id });
  const status = !p.appUrl ? "none" : s.session_status;
  const adapter = getProvider(p.id);
  return {
    id: p.id,
    name: p.name,
    purpose: p.purpose,
    appUrl: p.appUrl,
    kind: adapter?.kind ?? "browser",
    capabilities: adapter?.capabilities() ?? null,
    canChat: adapter ? adapter.supports("chat") : !!p.composerSelector,
    canSync: adapter ? adapter.supports("listTasks") : !!p.tasksUrl,
    signInMode: adapter?.preferredSignIn() ?? "live",
    builtin: adapter?.builtin ?? false,
    status, // logged_in | needs_login | error | unknown | none
    lastSync: s.last_sync_at,
    lastError: s.last_error,
    hasScreenshot: !!(s.screenshot_path && fs.existsSync(s.screenshot_path)),
    tasks: tasks.map((a) => ({
      id: a.id,
      name: a.name,
      schedule: a.schedule,
      status: a.status,
      native_url: a.native_url,
      last_run: a.last_run ? { status: a.last_run.status, at: a.last_run.finished_at || a.last_run.started_at || a.last_run.created_at, summary: a.last_run.summary } : null,
    })),
  };
}
export type ConnectionCard = ReturnType<typeof connectionCard>;
