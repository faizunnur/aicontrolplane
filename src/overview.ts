import { currentStepOf, listAgentProfiles, listEvents, listMessages, listRuns, listTasks, recentRunEvents, type RunRow } from "./db.js";
import { pendingApprovals } from "./policy.js";
import { getProvider, listProviders } from "./providers/registry.js";

/*
  What the Overview answers at a glance: what is running, what is scheduled, what finished, what
  failed, what needs you. Every number comes from rows; nothing is estimated.
*/

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

export function runWithStep(r: RunRow) {
  const step = currentStepOf(r.id);
  return { ...r, provider_name: r.provider ? getProvider(r.provider)?.name ?? r.provider : null, current_step: step?.label ?? null, current_step_status: step?.status ?? null, elapsed_s: r.started_at ? Math.max(0, Math.round(((r.finished_at ? new Date(r.finished_at).getTime() : Date.now()) - new Date(r.started_at).getTime()) / 1000)) : null };
}

export interface AttentionItem {
  kind: "approval" | "session" | "run" | "message" | "storage";
  id: number | string;
  title: string;
  body: string | null;
  platform: string | null;
  link: string | null;
  /** What the UI offers: decide an approval, sign in, open the chat, dismiss a notification. */
  action: "decide" | "connect" | "open_chat" | "dismiss" | "none";
  at: string | null;
}

export function attentionItems(): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of pendingApprovals()) items.push({ kind: "approval", id: a.id, title: a.summary, body: a.run_label ? `${a.run_label}${a.provider ? ` · ${getProvider(a.provider)?.name ?? a.provider}` : ""}` : null, platform: a.provider, link: null, action: "decide", at: a.requested_at });
  for (const p of listProviders()) {
    const c = p.connectionStatus();
    if (c.status === "needs_login") items.push({ kind: "session", id: p.id, title: `${p.name} needs you to sign in again`, body: c.lastError, platform: p.id, link: null, action: "connect", at: c.lastCheckedAt });
  }
  for (const m of listMessages({ status: "needs_assignment", limit: 10 })) items.push({ kind: "message", id: m.id, title: "Which AI should do this?", body: m.text, platform: null, link: null, action: "open_chat", at: m.created_at });
  for (const m of listMessages({ status: "failed", limit: 10 })) items.push({ kind: "message", id: m.id, title: "A message could not be handled", body: m.error ?? m.text, platform: m.platform, link: null, action: "open_chat", at: m.updated_at });
  for (const e of listEvents({ unread: true, limit: 20 })) if (e.kind === "run" || e.kind === "approval" || e.kind === "sync_error") items.push({ kind: "run", id: e.id, title: e.title, body: e.body, platform: e.platform, link: e.link, action: "dismiss", at: e.occurred_at });
  return items;
}

export function overview() {
  const since = startOfToday();
  const running = listRuns({ status: "running", limit: 100 }).map(runWithStep);
  const today = listRuns({ since, limit: 500 });
  const approvals = pendingApprovals();
  const agents = listAgentProfiles();
  const tasks = listTasks();
  const providers = listProviders().map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.connectionStatus().status }));
  const count = (s: string) => today.filter((r) => r.status === s).length;
  return {
    counts: {
      agents: agents.filter((a) => a.status === "active").length,
      tasks: tasks.length,
      scheduled: tasks.filter((t) => t.schedule || t.next_run).length,
      running: running.length,
      awaiting_approval: approvals.length,
      failed_today: count("failed") + count("needs_attention"),
      completed_today: count("success"),
      signed_out: providers.filter((p) => p.status === "needs_login").length,
      unread: listEvents({ unread: true, limit: 200 }).length,
    },
    running,
    attention: attentionItems(),
    recent: listRuns({ limit: 12 }).filter((r) => r.status !== "running").map(runWithStep),
    upcoming: tasks
      .filter((t) => t.next_run)
      .sort((a, b) => String(a.next_run).localeCompare(String(b.next_run)))
      .slice(0, 8)
      .map((t) => ({ id: t.id, name: t.name, platform: t.platform, provider_name: getProvider(t.platform)?.name ?? t.platform, next_run: t.next_run, schedule: t.schedule })),
    providers,
    at: new Date().toISOString(),
  };
}

/** The feed shows each step once, in its latest state, plus every log, approval, result and error line. */
export function activity(opts: { limit?: number; provider?: string; agent_id?: number; run_id?: number } = {}) {
  const rows = recentRunEvents({ ...opts, limit: Math.min((opts.limit ?? 100) * 3, 1000) });
  const seen = new Set<string>();
  const out = [];
  for (const e of rows) {
    if (e.type === "step" && e.key) {
      const k = `${e.run_id}:${e.key}`;
      if (seen.has(k)) continue; // an earlier (older) state of the same step
      seen.add(k);
    }
    out.push({ ...e, provider_name: e.provider ? getProvider(e.provider)?.name ?? e.provider : null });
    if (out.length >= (opts.limit ?? 100)) break;
  }
  return out;
}
