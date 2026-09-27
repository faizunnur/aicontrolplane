import { getAgentProfile, listTasks, updateTask, upsertAgentProfile, type AgentProfileSummary } from "./db.js";
import { logger } from "./logger.js";
import { getProvider } from "./providers/registry.js";
import type { ProviderOperation } from "./providers/types.js";
import type { Task } from "../packages/core/src/index.js";

const log = logger("agents");

/*
  Agents are who does the work. Three kinds:
    assistant  a provider's built-in AI (ChatGPT, Claude, …), one profile per provider
    custom     a program of your own that registered itself or was named in an ingest payload
    system     the control plane itself, for syncs, screenshots and actions it runs on your behalf
  Every task and every run is attached to one, so "what are my agents doing?" has an answer.
*/

export const SYSTEM_AGENT_KEY = "control-plane";

export async function ensureSystemAgent(): Promise<AgentProfileSummary> {
  return await upsertAgentProfile({ key: SYSTEM_AGENT_KEY, name: "Control plane", kind: "system", description: "The control plane itself: looking at providers, screenshots, and actions run on your behalf.", capabilities: ["sync", "screenshot", "action"] });
}

/** The built-in assistant of a provider, created on first use. Null for the custom-agents provider. */
export async function ensureProviderAgent(providerId: string): Promise<AgentProfileSummary | null> {
  const adapter = getProvider(providerId);
  if (!adapter || adapter.kind === "custom") return null;
  const caps = adapter.capabilities();
  const supported = (Object.keys(caps) as ProviderOperation[]).filter((op) => caps[op] !== null);
  return await upsertAgentProfile({ key: providerId, name: adapter.name, kind: "assistant", provider_id: providerId, description: adapter.config().purpose || null, capabilities: supported });
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
export async function ensureTaskAgent(task: Task, hint?: ProfileHint | null): Promise<AgentProfileSummary | null> {
  let agent: AgentProfileSummary | null = null;
  if (hint?.key) {
    agent = await upsertAgentProfile({ key: hint.key, name: hint.name, description: hint.description, provider_id: task.platform, kind: "custom", capabilities: hint.capabilities });
  } else if (task.agent_id) {
    agent = await getAgentProfile(task.agent_id) ?? null;
    if (agent) return agent;
  }
  if (!agent) {
    const adapter = getProvider(task.platform);
    agent = adapter && adapter.kind !== "custom" ? await ensureProviderAgent(task.platform) : await upsertAgentProfile({ key: `${task.platform}/${task.key}`, name: task.name, description: task.purpose, provider_id: task.platform, kind: "custom" });
  }
  if (agent && task.agent_id !== agent.id) await updateTask(task.id, { agent_id: agent.id });
  return agent;
}

/** Attach every task that has no agent yet. Runs at boot; cheap and idempotent. */
export async function backfillAgents(): Promise<number> {
  await ensureSystemAgent();
  let n = 0;
  for (const task of await listTasks({ includeDisabled: true })) {
    if (task.agent_id) continue;
    if (await ensureTaskAgent(task)) n++;
  }
  if (n) log.info(`attached ${n} task(s) to agent profiles`);
  return n;
}
