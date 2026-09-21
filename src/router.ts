import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { config } from "./config.js";
import { listAgents } from "./db.js";
import { logger } from "./logger.js";
import { getPlatforms } from "./platforms.js";
import type { Agent, Suggestion } from "./types.js";

const log = logger("router");

export interface RoutingResult {
  method: "mention" | "llm" | "keywords" | "none";
  suggestions: Suggestion[];
  top: Suggestion | null;
  confidence: number;
  reason: string;
  /** When nothing fits, a proposal for an agent that would. */
  new_agent: { platform: string; name: string; purpose: string } | null;
  llm_error?: string;
}

/* ---------- keyword scoring (always available, no network) ---------- */

const STOP = new Set(
  "a an the and or but if then so to of in on at for from by with about into over after before as is are was were be been being do does did have has had it its this that these those i me my we our you your they them their he she his her tell ask please can could would should will just also very really not no yes ok okay let make get go run send give need want".split(
    " ",
  ),
);

export function tokenize(s: string): string[] {
  return s
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

export function keywordRoute(text: string, agents: Agent[]): { suggestions: Suggestion[]; mention: Suggestion | null } {
  const platforms = getPlatforms();
  const tokens = tokenize(text);
  const stems = tokens.map(stem);
  const lower = text.toLowerCase();
  const scored: Suggestion[] = [];
  let mention: Suggestion | null = null;

  for (const a of agents) {
    const reasons: string[] = [];
    let score = 0;

    // Explicit mention: @key, @name, or the full name in quotes / verbatim.
    const nameLower = a.name.toLowerCase();
    if (lower.includes(`@${a.key.toLowerCase()}`) || lower.includes(`@${nameLower}`)) {
      mention = { agent_id: a.id, key: a.key, name: a.name, platform: a.platform, score: 1, reason: "mentioned explicitly" };
    } else if (nameLower.length >= 6 && lower.includes(nameLower)) {
      score += 6;
      reasons.push("name appears in the instruction");
    }

    const nameBag = bag([a.name, a.key]);
    const kwBag = bag([a.keywords]);
    const purposeBag = bag([a.purpose]);
    const nameHits = stems.filter((t) => nameBag.has(t));
    const kwHits = stems.filter((t) => kwBag.has(t));
    const purposeHits = stems.filter((t) => purposeBag.has(t));
    if (nameHits.length) {
      score += nameHits.length * 3;
      reasons.push(`name matches "${[...new Set(nameHits)].join(", ")}"`);
    }
    if (kwHits.length) {
      score += kwHits.length * 3;
      reasons.push(`keywords match "${[...new Set(kwHits)].join(", ")}"`);
    }
    if (purposeHits.length) {
      score += purposeHits.length;
      reasons.push(`purpose mentions "${[...new Set(purposeHits)].slice(0, 3).join(", ")}"`);
    }

    // Platform hint: "ask grok", "in chatgpt", "claude routine".
    const p = platforms[a.platform];
    const platformWords = bag([a.platform, p?.name]);
    if (stems.some((t) => platformWords.has(t))) {
      score += 2;
      reasons.push(`platform "${p?.name ?? a.platform}" named`);
    }

    if (score > 0) {
      scored.push({ agent_id: a.id, key: a.key, name: a.name, platform: a.platform, score, reason: reasons.join("; ") });
    }
  }

  scored.sort((x, y) => y.score - x.score);
  const s1 = scored[0]?.score ?? 0;
  const s2 = scored[1]?.score ?? 0;
  // Turn raw scores into 0..1 confidence, penalising a close runner-up.
  for (const s of scored) {
    let c = s.score / (s.score + 4);
    if (s === scored[0] && s2 >= s1 * 0.6) c *= 0.6;
    s.score = Math.round(Math.min(0.95, c) * 100) / 100;
  }
  return { suggestions: scored.slice(0, 5), mention };
}

/* ---------- LLM routing (optional) ---------- */

const RouteSchema = z.object({
  agent_key: z.string().nullable().describe("key of the responsible agent, or null if none fits"),
  platform: z.string().nullable().describe("platform id of that agent"),
  confidence: z.number().describe("0 to 1"),
  reason: z.string().describe("one sentence for the user"),
  alternatives: z.array(z.object({ agent_key: z.string(), platform: z.string(), reason: z.string() })).describe("up to 3 other plausible agents"),
  new_agent: z
    .object({ platform: z.string(), name: z.string(), purpose: z.string() })
    .nullable()
    .describe("if no agent fits, propose one the user could create"),
});

const SYSTEM = `You are the dispatcher for a personal AI control plane. The user runs AI agents on several platforms (ChatGPT scheduled tasks, Claude Code routines and Cowork, Grok bots, custom agents). Given the registry and an instruction typed by the user, decide which single agent is responsible for carrying it out.

Rules:
- Prefer an agent whose purpose or keywords cover the instruction. Name matches and platform mentions are strong signals.
- If the instruction names a platform but no agent there fits, set agent_key to null and propose a new_agent on that platform.
- confidence is your honest probability that this agent is the right one. Use 0.9+ only when it is unambiguous.
- Keep reason to one sentence written for the user, not for a machine.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ timeout: 30_000, maxRetries: 1 });
  return client;
}

function registryText(agents: Agent[]): string {
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

export async function llmRoute(text: string, agents: Agent[]): Promise<{ result: z.infer<typeof RouteSchema> | null; error?: string }> {
  try {
    const response = await anthropic().messages.parse({
      model: config.router.model,
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Registry:\n${registryText(agents)}\n\nInstruction from the user:\n${text}` }],
      output_config: { effort: "low", format: zodOutputFormat(RouteSchema) },
    });
    if (response.stop_reason === "refusal") return { result: null, error: "model declined to route this instruction" };
    if (!response.parsed_output) return { result: null, error: "model returned no structured answer" };
    return { result: response.parsed_output };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { result: null, error: "Anthropic credentials rejected" };
    if (err instanceof Anthropic.RateLimitError) return { result: null, error: "Anthropic rate limit, used keyword routing" };
    if (err instanceof Anthropic.APIError) return { result: null, error: `Anthropic API error ${err.status}: ${err.message}` };
    return { result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------- Claude Code provider (your subscription via CLAUDE_CODE_OAUTH_TOKEN) ---------- */

// The Claude Code runtime validates the schema itself and rejects the "$schema" header Zod emits.
const RouteJsonSchema = (({ $schema: _omit, ...rest }) => rest)(z.toJSONSchema(RouteSchema) as Record<string, unknown>);

/**
 * Same question, asked through the Claude Agent SDK. The SDK runs the bundled Claude Code
 * runtime as a subprocess; it authenticates with CLAUDE_CODE_OAUTH_TOKEN from the environment.
 * No tools, one turn, structured JSON back.
 */
export async function claudeCodeRoute(text: string, agents: Agent[]): Promise<{ result: z.infer<typeof RouteSchema> | null; error?: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.router.timeoutMs);
  try {
    const q = query({
      prompt: `Registry:\n${registryText(agents)}\n\nInstruction from the user:\n${text}`,
      options: {
        systemPrompt: SYSTEM,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "dontAsk",
        cwd: config.dataDir,
        outputFormat: { type: "json_schema", schema: RouteJsonSchema },
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
        // Belt and braces: some runtimes return the JSON as the result text instead.
        for (const s of [m.result, lastText]) {
          if (typeof s !== "string") continue;
          const match = s.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              candidates.push(JSON.parse(match[0]));
            } catch {
              /* not JSON */
            }
          }
        }
        for (const c of candidates) {
          const parsed = RouteSchema.safeParse(c);
          if (parsed.success) return { result: parsed.data };
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

/* ---------- combined ---------- */

export async function routeMessage(text: string): Promise<RoutingResult> {
  const agents = listAgents().filter((a) => a.enabled);
  if (agents.length === 0) {
    return { method: "none", suggestions: [], top: null, confidence: 0, reason: "No agents registered yet.", new_agent: null };
  }
  const kw = keywordRoute(text, agents);
  if (kw.mention) {
    const rest = kw.suggestions.filter((s) => s.agent_id !== kw.mention!.agent_id);
    return { method: "mention", suggestions: [kw.mention, ...rest], top: kw.mention, confidence: 1, reason: kw.mention.reason, new_agent: null };
  }

  if (config.router.llm) {
    const { result, error } = config.router.provider === "claude-code" ? await claudeCodeRoute(text, agents) : await llmRoute(text, agents);
    if (result) {
      const byKey = (key: string | null, platform: string | null) =>
        agents.find((a) => a.key === key && (!platform || a.platform === platform)) ?? agents.find((a) => a.key === key);
      const suggestions: Suggestion[] = [];
      const topAgent = byKey(result.agent_key, result.platform);
      if (topAgent) {
        suggestions.push({
          agent_id: topAgent.id,
          key: topAgent.key,
          name: topAgent.name,
          platform: topAgent.platform,
          score: Math.max(0, Math.min(1, result.confidence)),
          reason: result.reason,
        });
      }
      for (const alt of result.alternatives ?? []) {
        const a = byKey(alt.agent_key, alt.platform);
        if (a && !suggestions.some((s) => s.agent_id === a.id)) {
          suggestions.push({ agent_id: a.id, key: a.key, name: a.name, platform: a.platform, score: 0.4, reason: alt.reason });
        }
      }
      for (const s of kw.suggestions) if (!suggestions.some((x) => x.agent_id === s.agent_id)) suggestions.push({ ...s, score: Math.min(s.score, 0.35) });
      return {
        method: "llm",
        suggestions: suggestions.slice(0, 5),
        top: topAgent ? suggestions[0] : null,
        confidence: topAgent ? suggestions[0].score : 0,
        reason: result.reason,
        new_agent: result.new_agent ?? null,
      };
    }
    log.warn(`llm routing unavailable: ${error}`);
    const fallback = keywordResult(kw.suggestions, text);
    return { ...fallback, llm_error: error };
  }
  return keywordResult(kw.suggestions, text);
}

function keywordResult(suggestions: Suggestion[], text: string): RoutingResult {
  const top = suggestions[0] ?? null;
  const platforms = getPlatforms();
  const stems = tokenize(text).map(stem);
  const named = Object.values(platforms).find((p) => bag([p.id, p.name]).size && [...bag([p.id, p.name])].some((t) => stems.includes(t)));
  return {
    method: top ? "keywords" : "none",
    suggestions,
    top,
    confidence: top?.score ?? 0,
    reason: top ? `Best keyword match: ${top.reason}.` : "No agent's name, purpose or keywords match this instruction.",
    new_agent: top ? null : { platform: named?.id ?? "custom", name: text.slice(0, 40), purpose: text.slice(0, 200) },
  };
}
