import { config } from "./config.js";
import { listAgentProfiles, listTasks } from "./db.js";
import { logger } from "./logger.js";
import { listProviders } from "./providers/registry.js";
import { classifyWithClaude, tokenize } from "./router.js";
import type { Task } from "./types.js";

const log = logger("intents");

/*
  What did the user mean? Three kinds of message reach the chat box:

    question   about the control plane's own state ("what failed today?", "what needs my approval?")
    command    about a task or run the control plane manages ("run the security scan again", "pause the Grok monitor")
    chat       anything else: it goes to an AI provider, as before

  Questions and commands are answered here, from the database, and never typed into a provider.
  The rules below are deterministic; when a Claude credential is configured, ambiguous
  question-shaped text is checked with Claude too, and the deterministic answer wins on doubt.
*/

export type QuestionTopic = "running" | "scheduled" | "completed" | "failed" | "attention" | "approvals" | "agents" | "summary" | "status";
export type Timeframe = "today" | "yesterday" | "week" | "all";
export type CommandAction = "run" | "pause" | "resume" | "stop" | "continue" | "approve" | "reject";

export type Intent =
  | { kind: "question"; topic: QuestionTopic; provider: string | null; timeframe: Timeframe; source: "rules" | "claude" }
  | { kind: "command"; action: CommandAction; target: string; provider: string | null; source: "rules" | "claude" }
  | { kind: "chat"; source: "rules" | "claude" };

const QUESTION_START = /^(what|which|who|how|is|are|any|anything|do|does|did|show|list|summari[sz]e|give me|tell me|where)\b/;
// Stems are matched at a word start only ("approv" covers approve, approval, approvals).
const TOPICS: [QuestionTopic, RegExp][] = [
  ["approvals", /\b(approv|permission|sign[- ]?off|waiting for me|waiting on me)/],
  ["attention", /\b(need(s)? me|require(s)? (my )?attention|attention|needs? (my )?(help|input|review)|pending on me|blocked)\b/],
  ["failed", /\b(fail|error|broke|crash|went wrong|problem)/],
  ["running", /\b(running|in progress|doing|working on|busy|active|currently|right now|at the moment)\b/],
  ["completed", /\b(complet|finish|done|accomplish|produced|delivered|got done|results?)\b|\b(complet|finish|accomplish)/],
  ["scheduled", /\b(schedul|upcoming|next run|planned|coming up|when (does|will|is) .* run)/],
  ["summary", /\b(summar|recap|overview|what happened|digest)/],
  ["status", /\b(status|state of|how (is|are) (everything|things|it going|my agents|my tasks))\b/],
];

function providerIn(text: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const a of listProviders()) {
    for (const alias of a.aliases) {
      if (!alias) continue;
      const re = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
      if (re.test(text) && (!best || alias.length > best.len)) best = { id: a.id, len: alias.length };
    }
  }
  return best?.id ?? null;
}

function timeframeIn(text: string): Timeframe {
  if (/\byesterday\b/.test(text)) return "yesterday";
  if (/\b(this week|past week|last 7 days|weekly|week)\b/.test(text)) return "week";
  if (/\b(today|so far|this morning|tonight|last 24 hours|24h|since (this )?morning)\b/.test(text)) return "today";
  return "all";
}

/** "claude, do x" / "ask grok about y" / "@chatgpt …": addressed to a provider, so it is a chat. */
function addressesProvider(text: string): boolean {
  if (/^@[a-z]/.test(text)) return true;
  if (/^(ask|tell|hey|hi|ok|hello|dear)\s+/.test(text) && providerIn(text.split(/\s+/).slice(0, 3).join(" "))) return true;
  const head = text.split(/[,:]/)[0].trim();
  return head.length <= 24 && providerIn(head) !== null && /[,:]/.test(text);
}

const COMMANDS: [CommandAction, RegExp][] = [
  ["approve", /^(approve|accept|allow|yes,? (go ahead|do it|send it)|go ahead)\b(?:\s+(.*))?$/],
  ["reject", /^(reject|deny|decline|refuse|don'?t (send|do) (it|that)|no,? (don'?t|stop))\b(?:\s+(.*))?$/],
  ["run", /^(?:please\s+)?(run|start|trigger|kick off|launch|re-?run|execute|fire)\s+(?:the\s+)?(.+?)(?:\s+(?:again|now|please|right now|immediately))*[.!]?$/],
  ["pause", /^(?:please\s+)?(pause|disable|suspend|stop tracking|mute|turn off)\s+(?:the\s+)?(.+?)[.!]?$/],
  ["resume", /^(?:please\s+)?(resume|enable|unpause|reactivate|turn on)\s+(?:the\s+)?(.+?)[.!]?$/],
  ["stop", /^(?:please\s+)?(stop|cancel|abort|kill|halt)\s+(?:the\s+)?(.+?)[.!]?$/],
  ["continue", /^(?:please\s+)?(continue|carry on with|pick up|keep going with|finish)\s+(?:the\s+)?(.+?)[.!]?$/],
];

export function classify(raw: string): Intent {
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return { kind: "chat", source: "rules" };
  if (addressesProvider(text)) return { kind: "chat", source: "rules" };

  for (const [action, re] of COMMANDS) {
    const m = re.exec(text);
    if (!m) continue;
    const target = (action === "approve" || action === "reject" ? (m[m.length - 1] ?? "") : m[2]).trim();
    if (action === "approve" || action === "reject") return { kind: "command", action, target: target.replace(/^(it|that|this|the request|#)\s*/, "").trim(), provider: providerIn(text), source: "rules" };
    // Pausing, resuming or continuing something is a control-plane command by nature.
    if (action === "pause" || action === "resume" || action === "continue") return { kind: "command", action, target, provider: providerIn(target), source: "rules" };
    // "stop" and "run" are also ordinary words: only a target that names something we manage counts.
    if (action === "stop" && /^(waiting|the wait|it|that|this|everything|all|all runs|the run)$/.test(target)) return { kind: "command", action, target, provider: providerIn(text), source: "rules" };
    if (resolveTarget(target).matched || /\b(task|job|routine|automation|scan|monitor|report|briefing|research|sync|run|audit|digest|review|check)\b/.test(target)) {
      return { kind: "command", action, target, provider: providerIn(target), source: "rules" };
    }
  }

  if (QUESTION_START.test(text) || /\?$/.test(text)) {
    if (/\b(what|how) (are|is) (all )?(of )?my agents\b/.test(text)) return { kind: "question", topic: "agents", provider: null, timeframe: timeframeIn(text), source: "rules" };
    const aboutUs = /\b(agents?|tasks?|runs?|jobs?|routines?|automations?|approvals?|control plane|everything|things|my (work|stuff))\b/.test(text);
    for (const [topic, re] of TOPICS) {
      if (!re.test(text)) continue;
      // "what's trending in AI today?" mentions nothing of ours; a bare topic word is not enough without a subject.
      if (!aboutUs && !/\b(what|which|anything)\b.*\b(fail|running|complete|finish|approv|attention|schedul|status)/.test(text)) continue;
      return { kind: "question", topic, provider: providerIn(text), timeframe: timeframeIn(text), source: "rules" };
    }
  }
  return { kind: "chat", source: "rules" };
}

/** Deterministic first; Claude only reconsiders question-shaped or imperative text the rules left as chat. */
export async function classifyIntent(raw: string): Promise<Intent> {
  const rules = classify(raw);
  if (rules.kind !== "chat" || !config.router.llm) return rules;
  const text = raw.trim().toLowerCase();
  const worthAsking = (QUESTION_START.test(text) || /\?$/.test(text) || /^(run|start|pause|resume|stop|cancel|continue|approve|reject)\b/.test(text)) && !addressesProvider(text);
  if (!worthAsking) return rules;
  try {
    const r = await classifyWithClaude(raw, listProviders().map((a) => ({ id: a.id, name: a.name })), listTasks().map((t) => t.name));
    if (!r) return rules;
    if (r.kind === "control_question" && r.topic) return { kind: "question", topic: r.topic as QuestionTopic, provider: r.provider ?? null, timeframe: (r.timeframe as Timeframe) ?? "all", source: "claude" };
    if (r.kind === "task_command" && r.action && r.target) return { kind: "command", action: r.action as CommandAction, target: r.target, provider: r.provider ?? null, source: "claude" };
    return rules;
  } catch (err) {
    log.warn("intent check with Claude failed; keeping the rule-based answer", err);
    return rules;
  }
}

/* ---------- naming a task or agent in free text ---------- */

const FILLER = new Set(["task", "tasks", "job", "jobs", "routine", "routines", "automation", "automations", "agent", "agents", "run", "runs", "the", "my", "our", "one", "again", "now", "please", "it", "that", "this"]);

export interface TargetMatch {
  matched: boolean;
  task: Task | null;
  agentId: number | null;
  provider: string | null;
  candidates: { id: number; name: string; platform: string; score: number }[];
}

/** Find the task (or agent) the user named. Provider aliases narrow the search; leftover words score against names and purposes. */
export function resolveTarget(target: string): TargetMatch {
  const text = target.toLowerCase();
  const provider = providerIn(text);
  const providerWords = new Set(provider ? listProviders().find((a) => a.id === provider)?.aliases.flatMap((al) => al.split(/\s+/)) ?? [] : []);
  const words = [...new Set(tokenize(text).map((w) => w.replace(/(ings?|ed|es|s)$/u, "")))].filter((w) => !FILLER.has(w) && !providerWords.has(w));
  const tasks = listTasks({ platform: provider ?? undefined, includeDisabled: true });
  const scored = tasks
    .map((t) => {
      const hay = new Set([...tokenize(t.name), ...tokenize(t.key), ...tokenize(t.purpose ?? "")].map((w) => w.replace(/(ings?|ed|es|s)$/u, "")));
      const nameHay = new Set(tokenize(t.name).map((w) => w.replace(/(ings?|ed|es|s)$/u, "")));
      let score = 0;
      for (const w of words) {
        if (nameHay.has(w)) score += 3;
        else if (hay.has(w)) score += 1;
      }
      if (words.length && text.includes(t.name.toLowerCase())) score += 5;
      return { id: t.id, name: t.name, platform: t.platform, score, task: t };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { matched: true, task: scored[0].task, agentId: scored[0].task.agent_id, provider, candidates: scored.slice(0, 5).map(({ id, name, platform, score }) => ({ id, name, platform, score })) };
  }
  // No single task: maybe an agent by name.
  const agents = listAgentProfiles().filter((a) => words.length && words.every((w) => tokenize(a.name).map((x) => x.replace(/(ings?|ed|es|s)$/u, "")).includes(w)));
  if (agents.length === 1) return { matched: true, task: null, agentId: agents[0].id, provider: provider ?? agents[0].provider_id, candidates: scored.slice(0, 5).map(({ id, name, platform, score }) => ({ id, name, platform, score })) };
  return { matched: false, task: null, agentId: null, provider, candidates: scored.slice(0, 5).map(({ id, name, platform, score }) => ({ id, name, platform, score })) };
}
