import { z } from "zod/v4";
import { config } from "./config.js";
import { conversationMessages, foldSteps, listAgentProfiles, listEvents, listRuns, listTasks, runEvents, type RunRow } from "./db.js";
import { logger } from "./logger.js";
import { pendingApprovals } from "./policy.js";
import { listProviders } from "./providers/registry.js";
import { askJson } from "./router.js";
import type { Answer } from "./answers.js";
import type { Intent } from "./intents.js";

/*
  The control plane's own voice.

  Everything factual still happens in code: intents.ts decides what was meant, answers.ts reads the
  database or performs the command, policy.ts gates it. This module only says the result the way a
  person would say it, with the conversation so far in view, so the command panel feels like talking
  to an assistant who runs your agents rather than to a status page.

  With no Claude credential the deterministic sentence is used unchanged, so the control plane never
  depends on a model to be usable or truthful. Claude is given the facts and is told not to add any.
*/

const log = logger("assistant");

/** A reply must not be worth waiting for longer than this; the written answer is already correct. */
const TIMEOUT_MS = 25_000;
const HISTORY_TURNS = 8;
const BRIEFING_LIMIT = 8_000;

const ReplySchema = z.object({
  reply: z.string().min(1).max(1200).describe("what to say to the user, in their language, two or three sentences at most"),
});

const SYSTEM = `You are the assistant inside the user's AI Control Plane, speaking in its command panel. The control plane is where this person watches and steers their AI agents (ChatGPT, Claude, Grok, Gemini and programs of their own), the tasks those agents run, every run's timeline, and the approvals that gate risky actions. You are talking to its owner.

The control plane has already answered the question or carried out the command before you speak. Your job is to say what it found or did, the way a trusted colleague would.

Rules you must not break:
- Every fact you state comes from the briefing or from what the control plane just did. Never invent or guess a run, task, agent, provider, number, name, time or outcome. Keep the numbers and names exactly as given.
- Never change the outcome. If something failed, was refused, or was not found, say so plainly.
- If the briefing does not hold the answer, say what you do know and what you would need to answer the rest.
- Two or three sentences at most. No headings, no bold, no bullet list unless you are listing more than three things and the list is the answer.
- Warm and direct, like a colleague who keeps their operation running. Never chirpy, never apologetic, never "as an AI".
- You may offer one obvious next step, only from what this control plane can actually do: start, pause, resume or stop a task, approve or reject a request, sign in to a provider, or answer about state.
- Never promise to do something later and never ask the user to wait: the work is already done.`;

const providerLabel = (status: string, kind: string) => (status === "logged_in" ? "connected" : status === "needs_login" ? "signed out" : status === "error" ? "error" : kind === "custom" ? "via API" : "not connected");
const short = (s: string | null | undefined, n = 160) => (s ? String(s).replace(/\s+/g, " ").slice(0, n) : "");
const ago = (iso: string | null | undefined) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const stepOf = (r: RunRow) => {
  const steps = foldSteps(runEvents(r.id));
  const live = [...steps].reverse().find((s) => s.status === "running" || s.status === "waiting");
  return live?.label ?? steps.at(-1)?.label ?? "";
};

/**
 * What is true right now, in a few hundred words. Deterministic: the same rows the views read.
 * Only this, plus the answer the control plane computed, is what the reply may be built from.
 */
export function briefing(): string {
  const providers = listProviders().map((a) => {
    const s = a.connectionStatus();
    return `${a.name} (${a.id}): ${providerLabel(s.status, a.kind)}${s.lastError ? `, last error: ${short(s.lastError, 80)}` : ""}`;
  });
  const running = listRuns({ status: "running", limit: 10 });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const recent = listRuns({ since: today.toISOString(), limit: 40 });
  const failed = recent.filter((r) => r.status === "failed" || r.status === "needs_attention");
  const done = recent.filter((r) => r.status === "success");
  const approvals = pendingApprovals();
  const tasks = listTasks({ includeDisabled: true });
  const agents = listAgentProfiles();
  const events = listEvents({ limit: 5 });

  const out = [
    `Now: ${new Date().toISOString()}`,
    `Counts: ${agents.filter((a) => a.status === "active").length} agents, ${tasks.length} tasks, ${running.length} running, ${approvals.length} awaiting approval, ${failed.length} failed today, ${done.length} completed today.`,
    `Providers: ${providers.join(" | ") || "none"}`,
    running.length ? `Running now:\n${running.map((r) => `- run #${r.id} ${r.label ?? r.kind} on ${r.provider ?? "the control plane"}${r.agent_name ? ` by ${r.agent_name}` : ""}, step "${stepOf(r)}", started ${ago(r.started_at ?? r.created_at)}`).join("\n")}` : "Running now: nothing.",
    approvals.length ? `Awaiting your approval:\n${approvals.map((a) => `- approval #${a.id} ${short(a.summary)} (${a.action}${a.provider ? ` on ${a.provider}` : ""}), asked ${ago(a.requested_at)}`).join("\n")}` : "Awaiting your approval: nothing.",
    failed.length ? `Failed or needing attention today:\n${failed.slice(0, 10).map((r) => `- run #${r.id} ${r.label ?? r.kind} on ${r.provider ?? "the control plane"}: ${short(r.error ?? r.summary) || r.status}, ${ago(r.finished_at ?? r.started_at)}`).join("\n")}` : "Failed today: nothing.",
    done.length ? `Completed today:\n${done.slice(0, 10).map((r) => `- run #${r.id} ${r.label ?? r.kind} on ${r.provider ?? "the control plane"}${r.summary ? `: ${short(r.summary, 100)}` : ""}, ${ago(r.finished_at)}`).join("\n")}` : "Completed today: nothing.",
    tasks.length ? `Tasks in the registry:\n${tasks.slice(0, 20).map((t) => `- ${t.name} on ${t.platform}${t.schedule ? `, ${t.schedule}` : ""}${t.next_run ? `, next ${t.next_run}` : ""}${t.enabled ? "" : ", paused"}${t.last_run ? `, last run ${t.last_run.status}` : ""}`).join("\n")}` : "Tasks in the registry: none yet.",
    events.length ? `Recent notifications:\n${events.map((e) => `- ${short(e.title, 100)}${e.read ? "" : " (unread)"}, ${ago(e.occurred_at)}`).join("\n")}` : "",
  ].filter(Boolean);
  return out.join("\n").slice(0, BRIEFING_LIMIT);
}

/** The last few turns of this thread, so "and yesterday?" means something. */
function history(conversationId: number | null): string {
  if (!conversationId) return "";
  const turns = conversationMessages(conversationId)
    .slice(-HISTORY_TURNS - 1, -1)
    .map((m) => `User: ${short(m.text, 300)}${m.response ? `\nControl plane: ${short(m.response, 300)}` : ""}`);
  return turns.length ? `Earlier in this conversation:\n${turns.join("\n")}` : "";
}

function describeIntent(intent: Intent): string {
  if (intent.kind === "question") return `The user asked about: ${intent.topic}${intent.provider ? ` (provider ${intent.provider})` : ""}${intent.timeframe !== "all" ? `, timeframe ${intent.timeframe}` : ""}.`;
  if (intent.kind === "command") return `The user gave a command: ${intent.action} "${intent.target}". The control plane has already carried it out or refused it, as written below.`;
  if (intent.kind === "assistant") return intent.topic === "greeting" ? "The user greeted you or thanked you. Answer in one warm sentence and, only if it is useful, say in a clause what is going on right now." : "The user asked what you are or what you can do. Say it in two sentences, from what this control plane actually does.";
  return "";
}

export interface SpeakInput {
  /** What the user typed. */
  text: string;
  intent: Intent;
  /** What the control plane determined or did, deterministically. Its text is the fallback. */
  answer: Answer;
  conversationId: number | null;
}

/** The one call this module makes. A parameter so tests can exercise the wording path with no credential. */
export type Ask = (system: string, user: string, schema: typeof ReplySchema) => Promise<{ result: { reply: string } | null; error?: string }>;

/**
 * Turn the control plane's own answer into something worth reading. Falls back to that answer on
 * every failure, so a missing credential, a timeout or a refusal never costs the user their reply.
 */
export async function speak(input: SpeakInput, ask: Ask = askJson): Promise<{ text: string; source: "claude" | "control-plane" }> {
  const fallback = { text: input.answer.text, source: "control-plane" as const };
  if (!config.router.llm) return fallback;
  const user = [
    describeIntent(input.intent),
    "",
    "What the control plane determined and already did (this is the truth; do not change it):",
    input.answer.text,
    "",
    "Briefing (the only other facts you may use):",
    briefing(),
    "",
    history(input.conversationId),
    "",
    "The user's message:",
    input.text,
  ]
    .filter((s) => s !== undefined)
    .join("\n");
  try {
    const raced = await Promise.race([ask(SYSTEM, user, ReplySchema), new Promise<{ result: null; error: string }>((r) => setTimeout(() => r({ result: null, error: "took too long" }), TIMEOUT_MS).unref?.())]);
    const reply = raced.result?.reply?.trim();
    if (!reply) {
      log.warn(`saying it in the control plane's own words: ${raced.error ?? "no answer"}`);
      return fallback;
    }
    return { text: reply, source: "claude" };
  } catch (err) {
    log.warn("the assistant could not phrase this reply; using the control plane's own words", err);
    return fallback;
  }
}
