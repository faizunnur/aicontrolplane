import { speak } from "./assistant.js";
import { foldSteps, getMessage, getRun, getTask, listAgentProfiles, listEvents, listRuns, listTasks, runEvents, updateMessage, updateTask, type RunRow } from "./db.js";
import type { Intent, QuestionTopic, Timeframe } from "./intents.js";
import { resolveTarget } from "./intents.js";
import { decide, pendingApprovals, type Decision } from "./policy.js";
import { getProvider, listProviders } from "./providers/registry.js";
import { UnsupportedOperationError } from "./providers/types.js";
import { requestCancel } from "./runs.js";
import { startTask, TaskStartError } from "./tasks.js";

/*
  Answers to control-plane questions and the effects of control-plane commands. Everything here
  reads or changes the control plane's own state. Nothing here talks to a provider's chat.
*/

export interface Answer {
  text: string;
  data: unknown;
  /** How the message that asked should end up. */
  status?: "done" | "delivered" | "failed";
}

const providerName = (id: string | null | undefined) => (id ? getProvider(id)?.name ?? id : "the control plane");
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) : "");
const elapsed = (from: string | null | undefined, to?: string | null) => {
  if (!from) return "";
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const since = (tf: Timeframe): string | undefined => {
  const d = new Date();
  if (tf === "today") d.setHours(0, 0, 0, 0);
  else if (tf === "yesterday") {
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
  } else if (tf === "week") d.setDate(d.getDate() - 7);
  else return undefined;
  return d.toISOString();
};
const tfLabel = (tf: Timeframe) => ({ today: "today", yesterday: "yesterday", week: "this week", all: "" }[tf]);
const currentStep = (r: RunRow) => {
  const steps = foldSteps(runEvents(r.id));
  const live = [...steps].reverse().find((s) => s.status === "running" || s.status === "waiting");
  return live ? live.label : steps.at(-1)?.label ?? "";
};
const runLine = (r: RunRow) => `• ${r.label ?? r.task_name ?? r.kind} on ${providerName(r.provider)}${r.agent_name ? ` (${r.agent_name})` : ""}`;

export function answerQuestion(intent: Extract<Intent, { kind: "question" }>): Answer {
  const { topic, provider, timeframe } = intent;
  switch (topic) {
    case "running":
    case "agents":
      return running(provider, topic === "agents");
    case "failed":
      return failed(provider, timeframe);
    case "completed":
      return completed(provider, timeframe);
    case "scheduled":
      return scheduled(provider);
    case "approvals":
      return approvals();
    case "attention":
      return attention();
    case "summary":
      return summary(provider, timeframe === "all" ? "today" : timeframe);
    case "status":
      return status();
  }
}

function running(provider: string | null, byAgent: boolean): Answer {
  const runs = listRuns({ status: "running", platform: provider ?? undefined, limit: 50 });
  if (byAgent) {
    const agents = listAgentProfiles();
    const lines = agents.map((a) => {
      const mine = runs.filter((r) => r.agent_id === a.id);
      if (mine.length) return `• ${a.name}: ${mine.map((r) => `${r.label ?? r.kind} (${currentStep(r) || "working"}, ${elapsed(r.started_at)})`).join("; ")}`;
      return `• ${a.name}: idle${a.last_run_at ? `, last ran ${when(a.last_run_at)}` : ""}`;
    });
    return { text: lines.length ? `Your agents right now:\n${lines.join("\n")}` : "No agents yet. Sign in to an AI or register one of your own.", data: { runs, agents } };
  }
  if (!runs.length) return { text: provider ? `Nothing is running on ${providerName(provider)} right now.` : "Nothing is running right now.", data: { runs } };
  return { text: `${runs.length} running${provider ? ` on ${providerName(provider)}` : ""}:\n${runs.map((r) => `${runLine(r)}: ${currentStep(r) || "working"} · ${elapsed(r.started_at)}`).join("\n")}`, data: { runs } };
}

function failed(provider: string | null, tf: Timeframe): Answer {
  const runs = listRuns({ status: ["failed", "needs_attention"], platform: provider ?? undefined, since: since(tf === "all" ? "today" : tf), limit: 50 });
  const signedOut = listProviders().filter((a) => (!provider || a.id === provider) && a.connectionStatus().status === "needs_login");
  const lines = [...runs.map((r) => `${runLine(r)}: ${r.error ?? r.summary ?? r.status} (${when(r.finished_at ?? r.started_at)})`), ...signedOut.map((a) => `• ${a.name} signed you out; sign in again from the sidebar.`)];
  const label = tfLabel(tf === "all" ? "today" : tf);
  return { text: lines.length ? `${runs.length} failed${signedOut.length ? ` and ${signedOut.length} signed out` : ""} ${label}:\n${lines.join("\n")}` : `Nothing failed ${label}${provider ? ` on ${providerName(provider)}` : ""}.`, data: { runs, signedOut: signedOut.map((a) => a.id) } };
}

function completed(provider: string | null, tf: Timeframe): Answer {
  const runs = listRuns({ status: "success", platform: provider ?? undefined, since: since(tf === "all" ? "today" : tf), limit: 50 });
  const label = tfLabel(tf === "all" ? "today" : tf);
  if (!runs.length) return { text: `Nothing completed ${label}${provider ? ` on ${providerName(provider)}` : ""}.`, data: { runs } };
  return { text: `${runs.length} completed ${label}${provider ? ` on ${providerName(provider)}` : ""}:\n${runs.map((r) => `${runLine(r)}: ${r.summary ? r.summary.slice(0, 140) : "done"} (${when(r.finished_at)})`).join("\n")}`, data: { runs } };
}

function scheduled(provider: string | null): Answer {
  const tasks = listTasks({ platform: provider ?? undefined }).filter((t) => t.schedule || t.next_run);
  if (!tasks.length) return { text: provider ? `No scheduled tasks known on ${providerName(provider)}. The control plane learns them when it looks at the provider's tasks page.` : "No scheduled tasks known yet. They appear after the control plane looks at each provider's tasks page, or when your agents register them.", data: { tasks } };
  const byProvider = new Map<string, typeof tasks>();
  for (const t of tasks) byProvider.set(t.platform, [...(byProvider.get(t.platform) ?? []), t]);
  const blocks = [...byProvider.entries()].map(([p, ts]) => `${providerName(p)}:\n${ts.map((t) => `• ${t.name}${t.schedule ? ` · ${t.schedule}` : ""}${t.next_run ? ` · next ${when(t.next_run)}` : ""}${t.last_run ? ` · last ${t.last_run.status}` : ""}`).join("\n")}`);
  return { text: `${tasks.length} scheduled:\n${blocks.join("\n")}`, data: { tasks } };
}

function approvals(): Answer {
  const pending = pendingApprovals();
  if (!pending.length) return { text: "Nothing is waiting for your approval.", data: { pending } };
  return { text: `${pending.length} waiting for you:\n${pending.map((a) => `• #${a.id} ${a.summary}${a.run_label ? ` (${a.run_label})` : ""} · asked ${when(a.requested_at)}`).join("\n")}\nSay "approve #id" or "reject #id", or use the buttons in the thread.`, data: { pending }, status: "done" };
}

function attention(): Answer {
  const pending = pendingApprovals();
  const signedOut = listProviders().filter((a) => a.connectionStatus().status === "needs_login");
  const failedRuns = listRuns({ status: ["failed", "needs_attention"], since: since("today"), limit: 20 });
  const unread = listEvents({ unread: true, limit: 20 });
  const lines = [
    ...pending.map((a) => `• Approval #${a.id}: ${a.summary}`),
    ...signedOut.map((a) => `• ${a.name} needs you to sign in again`),
    ...failedRuns.map((r) => `• ${r.label ?? r.kind} on ${providerName(r.provider)} ${r.status === "failed" ? "failed" : "needs attention"}: ${r.error ?? r.summary ?? ""}`),
    ...unread.filter((e) => e.kind === "run" || e.kind === "approval").map((e) => `• ${e.title}`),
  ];
  return { text: lines.length ? `Needs you:\n${[...new Set(lines)].join("\n")}` : "Nothing needs you right now.", data: { pending, signedOut: signedOut.map((a) => a.id), failedRuns, unread } };
}

function summary(provider: string | null, tf: Timeframe): Answer {
  const from = since(tf);
  const runs = listRuns({ platform: provider ?? undefined, since: from, limit: 200 });
  const count = (s: string) => runs.filter((r) => r.status === s).length;
  const pending = pendingApprovals();
  const head = `${tfLabel(tf)[0].toUpperCase()}${tfLabel(tf).slice(1)}${provider ? ` on ${providerName(provider)}` : ""}: ${runs.length} runs · ${count("success")} completed · ${count("failed") + count("needs_attention")} failed · ${count("running")} running · ${pending.length} awaiting approval.`;
  const done = runs.filter((r) => r.status === "success").slice(0, 8).map((r) => `${runLine(r)}: ${r.summary ? r.summary.slice(0, 120) : "done"}`);
  const bad = runs.filter((r) => r.status === "failed" || r.status === "needs_attention").slice(0, 8).map((r) => `${runLine(r)}: ${r.error ?? r.summary ?? r.status}`);
  return { text: [head, done.length ? `Completed:\n${done.join("\n")}` : "", bad.length ? `Failed:\n${bad.join("\n")}` : ""].filter(Boolean).join("\n"), data: { runs, pending } };
}

function status(): Answer {
  const agents = listAgentProfiles();
  const running = listRuns({ status: "running", limit: 100 });
  const pending = pendingApprovals();
  const todayRuns = listRuns({ since: since("today"), limit: 500 });
  const failedToday = todayRuns.filter((r) => r.status === "failed" || r.status === "needs_attention").length;
  const doneToday = todayRuns.filter((r) => r.status === "success").length;
  const providers = listProviders().map((a) => `${a.name}: ${a.connectionStatus().status === "logged_in" ? "connected" : a.connectionStatus().status === "needs_login" ? "signed out" : a.kind === "custom" ? "via API" : "not connected"}`);
  return {
    text: `${agents.filter((a) => a.status === "active").length} agents · ${listTasks().length} tasks · ${running.length} running · ${pending.length} awaiting approval · ${failedToday} failed today · ${doneToday} completed today.\nProviders: ${providers.join(" · ")}`,
    data: { agents, running, pending, failedToday, doneToday },
  };
}

/* ---------- said to the control plane itself ---------- */

/** A greeting or "what can you do?". The facts are the same state everything else reads. */
function answerAssistant(intent: Extract<Intent, { kind: "assistant" }>): Answer {
  const state = status();
  if (intent.topic === "greeting") return { text: `Hello. ${state.text}`, data: state.data };
  const providers = listProviders().filter((a) => a.connectionStatus().status === "logged_in").map((a) => a.name);
  return {
    text: [
      "I am your control plane. I keep every AI agent you use in one place: what they are doing now, what they have done, what is scheduled, and what needs your approval before it happens.",
      "Ask me what is running, what failed today, what needs approval, or how an agent has been doing. Tell me to run, pause, resume, stop, approve or reject something and I do it here.",
      providers.length ? `Anything else goes to the AI you name, or to the best fit among ${providers.join(", ")}, and you can watch it work in the browser panel.` : "Sign in to an AI from the left and I can send your messages to it and watch it work in the browser panel.",
    ].join("\n"),
    data: { providers, ...(state.data as object) },
  };
}

/* ---------- commands ---------- */

export async function executeCommand(intent: Extract<Intent, { kind: "command" }>, ctx: { messageId: number }): Promise<Answer> {
  switch (intent.action) {
    case "approve":
    case "reject": {
      const idMatch = /(\d+)/.exec(intent.target);
      const pending = pendingApprovals();
      const target = idMatch ? pending.find((a) => a.id === Number(idMatch[1])) : pending[0];
      if (!target) return { text: idMatch ? `Approval #${idMatch[1]} is not pending.` : "Nothing is waiting for your approval.", data: null };
      const decision: Decision = intent.action === "approve" ? "approved" : "rejected";
      decide(target.id, decision, "you");
      return { text: `${decision === "approved" ? "Approved" : "Rejected"}: ${target.summary}`, data: { approval: target.id, decision } };
    }
    case "stop": {
      const all = /^(everything|all|all runs)$/.test(intent.target);
      const wait = /^(waiting|the wait|it|that|this|the run)$/.test(intent.target);
      let runs = listRuns({ status: "running", limit: 50 });
      if (!all && !wait) {
        const t = resolveTarget(intent.target);
        runs = runs.filter((r) => (t.task ? r.task_id === t.task.id : t.agentId ? r.agent_id === t.agentId : t.provider ? r.provider === t.provider : false));
      } else if (wait) runs = runs.slice(0, 1);
      if (!runs.length) return { text: all ? "Nothing is running." : `I found nothing running that matches "${intent.target}".`, data: null };
      for (const r of runs) requestCancel(r.id);
      return { text: `Stopping ${runs.length === 1 ? `${runs[0].label ?? runs[0].kind} on ${providerName(runs[0].provider)}` : `${runs.length} runs`}. Each stops at its next step.`, data: { runs: runs.map((r) => r.id) } };
    }
    case "pause":
    case "resume": {
      const t = resolveTarget(intent.target);
      if (!t.task) return notFound(intent.target, t.candidates);
      const enable = intent.action === "resume";
      updateTask(t.task.id, { enabled: enable });
      const adapter = getProvider(t.task.platform);
      const note = adapter && !adapter.supports("cancelTask") ? ` ${adapter.capabilityNotes().cancelTask ?? ""}`.trimEnd() : "";
      return { text: `${enable ? "Resumed" : "Paused"} ${t.task.name} here: the control plane ${enable ? "tracks it again" : "stops tracking it and will not start it"}.${note ? "\n" + note : ""}`, data: { task: t.task.id, enabled: enable } };
    }
    case "run":
    case "continue": {
      const t = resolveTarget(intent.target);
      if (!t.task) return notFound(intent.target, t.candidates);
      try {
        const run = await startTask(t.task.id, { messageId: ctx.messageId, trigger: "user", text: intent.action === "continue" ? "Continue where you left off." : undefined });
        if (run.status === "running") return { text: `Started ${t.task.name} at ${providerName(t.task.platform)}. Its agent will report back here.`, data: { run: run.id }, status: "delivered" };
        if (run.status === "success") return { text: `Started ${t.task.name} at ${providerName(t.task.platform)}.${run.output_url ? ` Watch it at ${run.output_url}` : ""}`, data: { run: run.id } };
        if (run.status === "cancelled") return { text: `${t.task.name} was not started: ${run.error ?? "not approved"}.`, data: { run: run.id } };
        return { text: `${t.task.name} could not be started: ${run.error ?? "unknown error"}`, data: { run: run.id }, status: "failed" };
      } catch (err) {
        if (err instanceof UnsupportedOperationError || err instanceof TaskStartError) {
          const adapter = getProvider(t.task.platform);
          const where = t.task.native_url ?? adapter?.config().tasksUrl;
          return { text: `${t.task.name} cannot be ${intent.action === "continue" ? "continued" : "started"} from here: ${err instanceof UnsupportedOperationError ? err.reason : err.message}${where ? `\nOpen it at ${where}` : ""}${adapter?.supports("chat") ? `, or write to ${adapter.name} directly ("${adapter.name}, …").` : "."}`, data: { task: t.task.id } };
        }
        throw err;
      }
    }
  }
}

function notFound(target: string, candidates: { id: number; name: string; platform: string }[]): Answer {
  const known = listTasks().slice(0, 12).map((t) => `${t.name} (${providerName(t.platform)})`);
  const hint = candidates.length ? `Did you mean: ${candidates.map((c) => `${c.name} (${providerName(c.platform)})`).join(", ")}?` : known.length ? `Tasks I know: ${known.join(", ")}.` : "I know no tasks yet.";
  return { text: `I could not find a task called "${target}". ${hint}`, data: { candidates } };
}

/** Run a control-plane intent for a message and record the outcome on the message. */
export async function handleControl(intent: Exclude<Intent, { kind: "chat" }>, messageId: number): Promise<Answer> {
  const reason = intent.kind === "question" ? `Answered from the control plane (${intent.topic}).` : intent.kind === "command" ? `Control-plane command: ${intent.action}.` : "Said to the control plane.";
  updateMessage(messageId, { routing: { method: "control", confidence: 1, reason, intent }, status: "delivered", delivered_at: new Date().toISOString() });
  let answer: Answer;
  try {
    answer = intent.kind === "question" ? answerQuestion(intent) : intent.kind === "assistant" ? answerAssistant(intent) : await executeCommand(intent, { messageId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateMessage(messageId, { status: "failed", error });
    return { text: error, data: null, status: "failed" };
  }
  const m = getMessage(messageId);
  // The control plane has decided and acted; Claude, when configured, only says it in better words.
  const spoken = await speak({ text: m?.text ?? "", intent, answer, conversationId: m?.conversation_id ?? null });
  answer = { ...answer, text: spoken.text };
  const status = answer.status ?? "done";
  updateMessage(messageId, {
    status,
    response: answer.text,
    routing: { method: "control", confidence: 1, reason: spoken.source === "claude" ? `${reason} Worded by Claude.` : reason, intent },
    acked_at: status === "done" ? new Date().toISOString() : null,
    error: status === "failed" ? answer.text : null,
    run_id: m?.run_id ?? null,
  });
  return answer;
}

/** When a task run started by a command finishes later, the message that asked for it follows. */
export function settleCommandMessage(runId: number) {
  const run = getRun(runId);
  if (!run || run.kind !== "task" || !run.message_id) return;
  const m = getMessage(run.message_id);
  if (!m || m.status !== "delivered") return;
  const task = run.task_id ? getTask(run.task_id) : null;
  const text = run.status === "success" ? `${task?.name ?? run.label ?? "The task"} finished: ${run.summary ?? "done"}${run.output_url ? `\n${run.output_url}` : ""}` : `${task?.name ?? run.label ?? "The task"} ${run.status === "cancelled" ? "was stopped" : "failed"}: ${run.error ?? run.summary ?? ""}`;
  updateMessage(m.id, { status: run.status === "success" ? "done" : run.status === "cancelled" ? "cancelled" : "failed", response: run.status === "success" ? text : m.response, error: run.status === "success" ? null : text, acked_at: new Date().toISOString() });
}

export type { QuestionTopic };
