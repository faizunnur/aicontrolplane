import { getAgentProfile, listTasks, updateTask, upsertAgentProfile, type AgentProfileSummary } from "./db.js";
import { logger } from "./logger.js";
import { getProvider } from "./providers/registry.js";
import type { ProviderOperation } from "./providers/types.js";
import type { Task } from "./types.js";

const log = logger("agents");

/*
  Agents are who does the work. Three kinds:
    assistant  a provider's built-in AI (ChatGPT, Claude, …), one profile per provider
    custom     a program of your own that registered itself or was named in an ingest payload
    system     the control plane itself, for syncs, screenshots and actions it runs on your behalf
  Every task and every run is attached to one, so "what are my agents doing?" has an answer.
*/

export const SYSTEM_AGENT_KEY = "control-plane";

export function ensureSystemAgent(): AgentProfileSummary {
  return upsertAgentProfile({ key: SYSTEM_AGENT_KEY, name: "Control plane", kind: "system", description: "The control plane itself: looking at providers, screenshots, and actions run on your behalf.", capabilities: ["sync", "screenshot", "action"] });
}

/** The built-in assistant of a provider, created on first use. Null for the custom-agents provider. */
export function ensureProviderAgent(providerId: string): AgentProfileSummary | null {
  const adapter = getProvider(providerId);
  if (!adapter || adapter.kind === "custom") return null;
  const caps = adapter.capabilities();
  const supported = (Object.keys(caps) as ProviderOperation[]).filter((op) => caps[op] !== null);
  return upsertAgentProfile({ key: providerId, name: adapter.name, kind: "assistant", provider_id: providerId, description: adapter.config().purpose || null, capabilities: supported });
}

export interface ProfileHint {
  key: string;
  name?: string;
  description?: string | null;
  capabilities?: string[] | null;
}

/**
 * The agent behind a task. A named profile (from an ingest payload) wins; otherwise a task at a
 * provider belongs to that provider's assistant, and a custom task gets a profile of its own.
 */
export function ensureTaskAgent(task: Task, hint?: ProfileHint | null): AgentProfileSummary | null {
  let agent: AgentProfileSummary | null = null;
  if (hint?.key) {
    agent = upsertAgentProfile({ key: hint.key, name: hint.name, description: hint.description, provider_id: task.platform, kind: "custom", capabilities: hint.capabilities });
  } else if (task.agent_id) {
    agent = getAgentProfile(task.agent_id) ?? null;
    if (agent) return agent;
  }
  if (!agent) {
    const adapter = getProvider(task.platform);
    agent = adapter && adapter.kind !== "custom" ? ensureProviderAgent(task.platform) : upsertAgentProfile({ key: `${task.platform}/${task.key}`, name: task.name, description: task.purpose, provider_id: task.platform, kind: "custom" });
  }
  if (agent && task.agent_id !== agent.id) updateTask(task.id, { agent_id: agent.id });
  return agent;
}

/** Attach every task that has no agent yet. Runs at boot; cheap and idempotent. */
export function backfillAgents(): number {
  ensureSystemAgent();
  let n = 0;
  for (const task of listTasks({ includeDisabled: true })) {
    if (task.agent_id) continue;
    if (ensureTaskAgent(task)) n++;
  }
  if (n) log.info(`attached ${n} task(s) to agent profiles`);
  return n;
}
