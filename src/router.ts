import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { config } from "./config.js";
import { getPlatformState, listTasks } from "./db.js";
import { logger } from "./logger.js";
import { getPlatforms, visiblePlatforms } from "./platforms.js";
import { getProvider } from "./providers/registry.js";
import type { Task, PlatformConfig, Suggestion } from "./types.js";

const log = logger("router");

/* =====================================================================
   Routing to an AI (connection). This is what Chat uses.
   ===================================================================== */

export interface ConnectionChoice {
  platform: string;
  name: string;
  /** 0..1 */
  confidence: number;
  reason: string;
}
export interface ConnectionRouting {
  method: "mention" | "only" | "llm" | "keywords" | "none";
  top: ConnectionChoice | null;
  options: ConnectionChoice[];
  reason: string;
  llm_error?: string;
}

/** AIs that are ready to take an instruction right now. */
export function connectedPlatforms(): PlatformConfig[] {
  return visiblePlatforms().filter((p) => p.composerSelector && getPlatformState(p.id).session_status === "logged_in");
}

function mentioned(text: string, p: PlatformConfig): boolean {
  const lower = text.toLowerCase();
  // The provider adapter knows the names people use for it ("gpt", "anthropic", "x.ai", …).
  const names = getProvider(p.id)?.aliases ?? [p.id.toLowerCase(), p.name.toLowerCase()];
  return names.some((n) => n && (lower.includes(`@${n}`) || new RegExp(`(^|\\b)(ask|tell|use|in|on|via|with|to)\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower) || new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,:]`).test(lower)));
}

export async function routeToConnection(text: string): Promise<ConnectionRouting> {
  const connected = connectedPlatforms();
  const all = visiblePlatforms().filter((p) => p.composerSelector);
  const choice = (p: PlatformConfig, confidence: number, reason: string): ConnectionChoice => ({ platform: p.id, name: p.name, confidence, reason });

  if (all.length === 0) return { method: "none", top: null, options: [], reason: "No AI is set up yet. Open Connect and sign in to one." };

  // 1. Explicit mention wins, even if that AI is not connected (the user will be told).
  const named = all.find((p) => mentioned(text, p));
  if (named) {
    const c = choice(named, 1, `You named ${named.name}.`);
    return { method: "mention", top: c, options: [c, ...connected.filter((p) => p.id !== named.id).map((p) => choice(p, 0.2, ""))], reason: c.reason };
  }

  if (connected.length === 0) {
    return { method: "none", top: null, options: all.map((p) => choice(p, 0, "not connected")), reason: "None of your AIs is signed in. Open Connect first." };
  }
  // 2. One connected AI: no decision to make.
  if (connected.length === 1) {
    const c = choice(connected[0], 0.85, `${connected[0].name} is the only AI connected.`);
    return { method: "only", top: c, options: [c], reason: c.reason };
  }

  // 3. Ask Claude, if a credential is configured.
  if (config.router.llm) {
    const { result, error } = await askConnectionLlm(text, connected);
    if (result) {
      const top = connected.find((p) => p.id === result.platform);
      const options = [
        ...(top ? [choice(top, Math.max(0, Math.min(1, result.confidence)), result.reason)] : []),
        ...connected.filter((p) => p.id !== result.platform).map((p) => choice(p, 0.2, "")),
      ];
      return { method: "llm", top: top ? options[0] : null, options, reason: result.reason };
    }
    log.warn(`llm routing unavailable: ${error}`);
    return { ...keywordConnection(text, connected), llm_error: error };
  }
  return keywordConnection(text, connected);
}

function keywordConnection(text: string, connected: PlatformConfig[]): ConnectionRouting {
  const stems = tokenize(text).map(stem);
  const scored = connected
    .map((p) => {
      const words = new Set(tokenize(p.purpose).map(stem));
      const hits = stems.filter((t) => words.has(t));
      return { p, hits: [...new Set(hits)] };
    })
    .sort((a, b) => b.hits.length - a.hits.length);
  const best = scored[0];
  if (best && best.hits.length > 0 && (scored[1]?.hits.length ?? 0) < best.hits.length) {
    const conf = Math.min(0.9, 0.55 + best.hits.length * 0.12);
    const top = { platform: best.p.id, name: best.p.name, confidence: conf, reason: `${best.p.name} is set up for "${best.hits.slice(0, 3).join(", ")}".` };
    return { method: "keywords", top, options: [top, ...scored.slice(1).map((s) => ({ platform: s.p.id, name: s.p.name, confidence: 0.2, reason: "" }))], reason: top.reason };
  }
  return {
    method: "none",
    top: null,
    options: connected.map((p) => ({ platform: p.id, name: p.name, confidence: 0.3, reason: p.purpose })),
    reason: "Which AI should do this? Pick one, or name it next time (\"ask Grok…\").",
  };
}

const ConnectionSchema = z.object({
  platform: z.string().describe("id of the AI that should handle this"),
  confidence: z.number().describe("0 to 1"),
  reason: z.string().describe("one short sentence for the user"),
});

const CONNECTION_SYSTEM = `You are the dispatcher for a personal AI control plane. The user has several AI assistants signed in (ChatGPT, Claude, Grok, …), each described by what they use it for. Given an instruction the user typed, pick the single AI that should carry it out. Prefer the AI whose description fits; when the instruction mentions a product feature (scheduled tasks, Claude Code, X/Twitter), pick the AI that owns it. confidence is your honest probability; use 0.9+ only when it is obvious. reason is one short sentence for the user.`;

async function askConnectionLlm(text: string, connected: PlatformConfig[]) {
  const registry = connected.map((p) => `- id=${p.id} name="${p.name}" used for: ${p.purpose || "(no description)"}`).join("\n");
  const user = `Connected AIs:\n${registry}\n\nInstruction from the user:\n${text}`;
  return askJson(CONNECTION_SYSTEM, user, ConnectionSchema);
}

/* =====================================================================
   Routing to a specific agent/task (used by the developer API and inbox flows).
   ===================================================================== */

export interface RoutingResult {
  method: "mention" | "llm" | "keywords" | "none";
  suggestions: Suggestion[];
  top: Suggestion | null;
  confidence: number;
  reason: string;
  new_agent: { platform: string; name: string; purpose: string } | null;
  llm_error?: string;
}

const STOP = new Set(
  "a an the and or but if then so to of in on at for from by with about into over after before as is are was were be been being do does did have has had it its this that these those i me my we our you your they them their he she his her tell ask please can could would should will just also very really not no yes ok okay let make get go run send give need want".split(
    " ",
  ),
);

export function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@_-]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}
function stem(t: string): string {
  return t.replace(/(ings?|ed|es|s)$/u, "");
}
function bag(parts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const p of parts) for (const t of tokenize(p ?? "")) out.add(stem(t));
  return out;
}

export function keywordRoute(text: string, agents: Task[]): { suggestions: Suggestion[]; mention: Suggestion | null } {
  const platforms = getPlatforms();
  const stems = tokenize(text).map(stem);
  const lower = text.toLowerCase();
  const scored: Suggestion[] = [];
  let mention: Suggestion | null = null;
  for (const a of agents) {
    const reasons: string[] = [];
    let score = 0;
    const nameLower = a.name.toLowerCase();
    if (lower.includes(`@${a.key.toLowerCase()}`) || lower.includes(`@${nameLower}`)) {
      mention = { task_id: a.id, key: a.key, name: a.name, platform: a.platform, score: 1, reason: "mentioned explicitly" };
    } else if (nameLower.length >= 6 && lower.includes(nameLower)) {
      score += 6;
      reasons.push("name appears in the instruction");
    }
    const nameHits = stems.filter((t) => bag([a.name, a.key]).has(t));
    const kwHits = stems.filter((t) => bag([a.keywords]).has(t));
    const purposeHits = stems.filter((t) => bag([a.purpose]).has(t));
    if (nameHits.length) score += nameHits.length * 3, reasons.push(`name matches "${[...new Set(nameHits)].join(", ")}"`);
    if (kwHits.length) score += kwHits.length * 3, reasons.push(`keywords match "${[...new Set(kwHits)].join(", ")}"`);
    if (purposeHits.length) score += purposeHits.length, reasons.push(`purpose mentions "${[...new Set(purposeHits)].slice(0, 3).join(", ")}"`);
    const p = platforms[a.platform];
    if (stems.some((t) => bag([a.platform, p?.name]).has(t))) score += 2, reasons.push(`platform "${p?.name ?? a.platform}" named`);
    if (score > 0) scored.push({ task_id: a.id, key: a.key, name: a.name, platform: a.platform, score, reason: reasons.join("; ") });
  }
  scored.sort((x, y) => y.score - x.score);
  const s1 = scored[0]?.score ?? 0;
  const s2 = scored[1]?.score ?? 0;
  for (const s of scored) {
    let c = s.score / (s.score + 4);
    if (s === scored[0] && s2 >= s1 * 0.6) c *= 0.6;
    s.score = Math.round(Math.min(0.95, c) * 100) / 100;
  }
  return { suggestions: scored.slice(0, 5), mention };
}

const RouteSchema = z.object({
  agent_key: z.string().nullable().describe("key of the responsible agent, or null if none fits"),
  platform: z.string().nullable().describe("platform id of that agent"),
  confidence: z.number().describe("0 to 1"),
  reason: z.string().describe("one sentence for the user"),
  alternatives: z.array(z.object({ agent_key: z.string(), platform: z.string(), reason: z.string() })).describe("up to 3 other plausible agents"),
  new_agent: z.object({ platform: z.string(), name: z.string(), purpose: z.string() }).nullable().describe("if no agent fits, propose one the user could create"),
});

const AGENT_SYSTEM = `You are the dispatcher for a personal AI control plane. The user runs AI agents on several platforms. Given the registry and an instruction typed by the user, decide which single agent is responsible for carrying it out.

Rules:
- Prefer an agent whose purpose or keywords cover the instruction. Name matches and platform mentions are strong signals.
- If the instruction names a platform but no agent there fits, set agent_key to null and propose a new_agent on that platform.
- confidence is your honest probability that this agent is the right one. Use 0.9+ only when it is unambiguous.
- Keep reason to one sentence written for the user, not for a machine.`;

function registryText(agents: Task[]): string {
  const platforms = getPlatforms();
  return [...agents]
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.key.localeCompare(b.key))
    .map((a) => {
      const bits = [`- key=${a.key} platform=${a.platform} (${platforms[a.platform]?.name ?? a.platform}) name="${a.name}"`];
      if (a.purpose) bits.push(`purpose="${a.purpose.replace(/\s+/g, " ").slice(0, 300)}"`);
      if (a.schedule) bits.push(`schedule="${a.schedule}"`);
      if (a.keywords) bits.push(`keywords="${a.keywords}"`);
      return bits.join(" ");
    })
    .join("\n");
}

export async function routeMessage(text: string): Promise<RoutingResult> {
  const agents = listTasks().filter((a) => a.enabled);
  if (agents.length === 0) return { method: "none", suggestions: [], top: null, confidence: 0, reason: "No agents registered yet.", new_agent: null };
  const kw = keywordRoute(text, agents);
  if (kw.mention) {
    const rest = kw.suggestions.filter((s) => s.task_id !== kw.mention!.task_id);
    return { method: "mention", suggestions: [kw.mention, ...rest], top: kw.mention, confidence: 1, reason: kw.mention.reason, new_agent: null };
  }
  if (config.router.llm) {
    const { result, error } = await askJson(AGENT_SYSTEM, `Registry:\n${registryText(agents)}\n\nInstruction from the user:\n${text}`, RouteSchema);
    if (result) {
      const byKey = (key: string | null, platform: string | null) =>
        agents.find((a) => a.key === key && (!platform || a.platform === platform)) ?? agents.find((a) => a.key === key);
      const suggestions: Suggestion[] = [];
      const topAgent = byKey(result.agent_key, result.platform);
      if (topAgent) suggestions.push({ task_id: topAgent.id, key: topAgent.key, name: topAgent.name, platform: topAgent.platform, score: Math.max(0, Math.min(1, result.confidence)), reason: result.reason });
      for (const alt of result.alternatives ?? []) {
        const a = byKey(alt.agent_key, alt.platform);
        if (a && !suggestions.some((s) => s.task_id === a.id)) suggestions.push({ task_id: a.id, key: a.key, name: a.name, platform: a.platform, score: 0.4, reason: alt.reason });
      }
      for (const s of kw.suggestions) if (!suggestions.some((x) => x.task_id === s.task_id)) suggestions.push({ ...s, score: Math.min(s.score, 0.35) });
      return { method: "llm", suggestions: suggestions.slice(0, 5), top: topAgent ? suggestions[0] : null, confidence: topAgent ? suggestions[0].score : 0, reason: result.reason, new_agent: result.new_agent ?? null };
    }
    log.warn(`llm routing unavailable: ${error}`);
    return { ...keywordResult(kw.suggestions, text), llm_error: error };
  }
  return keywordResult(kw.suggestions, text);
}

function keywordResult(suggestions: Suggestion[], text: string): RoutingResult {
  const top = suggestions[0] ?? null;
  const platforms = getPlatforms();
  const stems = tokenize(text).map(stem);
  const named = Object.values(platforms).find((p) => [...bag([p.id, p.name])].some((t) => stems.includes(t)));
  return {
    method: top ? "keywords" : "none",
    suggestions,
    top,
    confidence: top?.score ?? 0,
    reason: top ? `Best keyword match: ${top.reason}.` : "No agent's name, purpose or keywords match this instruction.",
    new_agent: top ? null : { platform: named?.id ?? "custom", name: text.slice(0, 40), purpose: text.slice(0, 200) },
  };
}

/* =====================================================================
   Is this message for the control plane or for a provider? (used by src/intents.ts)
   ===================================================================== */

const IntentSchema = z.object({
  kind: z.enum(["control_question", "task_command", "provider_chat"]).describe("control_question: asks about the state of the user's agents, tasks, runs or approvals; task_command: run/pause/resume/stop/continue a task or approve/reject a request; provider_chat: anything to be answered by an AI assistant"),
  topic: z.enum(["running", "scheduled", "completed", "failed", "attention", "approvals", "agents", "summary", "status"]).nullable().describe("for control_question"),
  action: z.enum(["run", "pause", "resume", "stop", "continue", "approve", "reject"]).nullable().describe("for task_command"),
  target: z.string().nullable().describe("for task_command: the task or agent named, as the user wrote it"),
  provider: z.string().nullable().describe("provider id the message is about, if one is named"),
  timeframe: z.enum(["today", "yesterday", "week", "all"]).nullable(),
});
const INTENT_SYSTEM = `You classify one message typed into an AI control plane that manages the user's AI agents, their scheduled tasks and runs across providers. Decide whether the message asks the control plane about its own state (control_question), tells the control plane to act on a task or approval (task_command), or is meant for an AI assistant to answer (provider_chat). Questions about the world, requests for writing, research or opinions are provider_chat even when they mention an AI's name. Be strict: only messages about the user's own agents, tasks, runs or approvals are control questions.`;

export async function classifyWithClaude(text: string, providers: { id: string; name: string }[], taskNames: string[]) {
  const user = `Providers: ${providers.map((p) => `${p.id} (${p.name})`).join(", ") || "none"}\nKnown tasks: ${taskNames.slice(0, 40).join("; ") || "none"}\n\nMessage:\n${text}`;
  const { result } = await askJson(INTENT_SYSTEM, user, IntentSchema);
  return result;
}

/* =====================================================================
   One "ask Claude for JSON" helper for both providers.
   ===================================================================== */

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ timeout: 30_000, maxRetries: 1 });
  return client;
}

export async function askJson<T extends z.ZodTypeAny>(system: string, user: string, schema: T): Promise<{ result: z.infer<T> | null; error?: string }> {
  if (config.router.provider === "claude-code") return askClaudeCode(system, user, schema);
  try {
    const response = await anthropic().messages.parse({
      model: config.router.model || "claude-opus-5",
      max_tokens: 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: zodOutputFormat(schema) },
    });
    if (response.stop_reason === "refusal") return { result: null, error: "Claude declined to route this instruction" };
    if (!response.parsed_output) return { result: null, error: "Claude returned no structured answer" };
    return { result: response.parsed_output as z.infer<T> };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { result: null, error: "Anthropic credentials rejected" };
    if (err instanceof Anthropic.RateLimitError) return { result: null, error: "Anthropic rate limit; used keyword routing" };
    if (err instanceof Anthropic.APIError) return { result: null, error: `Anthropic API error ${err.status}: ${err.message}` };
    return { result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Same question through the Claude Task SDK, authenticated by CLAUDE_CODE_OAUTH_TOKEN (your subscription). */
async function askClaudeCode<T extends z.ZodTypeAny>(system: string, user: string, schema: T): Promise<{ result: z.infer<T> | null; error?: string }> {
  // The Claude Code runtime validates the schema itself and rejects the "$schema" header Zod emits.
  const { $schema: _omit, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.router.timeoutMs);
  try {
    const q = query({
      prompt: user,
      options: {
        systemPrompt: system,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "dontAsk",
        cwd: config.dataDir,
        outputFormat: { type: "json_schema", schema: jsonSchema },
        abortController: abort,
        ...(config.router.model ? { model: config.router.model } : {}),
      },
    });
    let lastText = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        for (const block of m.message.content) if (block.type === "text") lastText = block.text;
      } else if (m.type === "result") {
        if (m.subtype !== "success") return { result: null, error: `Claude Code ended with ${m.subtype}` };
        const candidates: unknown[] = [m.structured_output];
        for (const s of [m.result, lastText]) {
          const match = typeof s === "string" ? s.match(/\{[\s\S]*\}/) : null;
          if (match) {
            try {
              candidates.push(JSON.parse(match[0]));
            } catch {
              /* not JSON */
            }
          }
        }
        for (const c of candidates) {
          const parsed = schema.safeParse(c);
          if (parsed.success) return { result: parsed.data as z.infer<T> };
        }
        return { result: null, error: "Claude Code answered without the expected JSON" };
      }
    }
    return { result: null, error: "Claude Code returned no result" };
  } catch (err) {
    if (abort.signal.aborted) return { result: null, error: `Claude Code timed out after ${Math.round(config.router.timeoutMs / 1000)}s` };
    const msg = err instanceof Error ? err.message : String(err);
    return { result: null, error: /auth|login|token|401|403/i.test(msg) ? `Claude Code could not authenticate: ${msg}` : msg };
  } finally {
    clearTimeout(timer);
  }
}
