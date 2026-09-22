import { BrowserProviderAdapter } from "./browser-adapter.js";
import type { CapabilityNotes, ExecutionContext, ProviderCapabilities, RunTaskInput, RunTaskResult, TaskRef } from "./types.js";

/**
 * Claude (claude.ai, Claude Code routines, Cowork). Verified 2026-09-22 against
 * code.claude.com/docs/en/routines: routines are listed and managed on claude.ai/code/routines
 * (browser), and the only documented API is the per-routine "fire" trigger
 * (POST https://api.anthropic.com/v1/claude_code/routines/{trigger}/fire with a per-routine
 * bearer token and the anthropic-beta: experimental-cc-routine-2026-04-01 header, research
 * preview). No API lists routines or runs. Starting a routine uses that endpoint when the task's
 * configuration holds its fire URL and token; the run's outcome is not observable through any API.
 */
export const CLAUDE_ROUTINE_BETA = "experimental-cc-routine-2026-04-01";

export class ClaudeAdapter extends BrowserProviderAdapter {
  protected extraAliases() {
    return ["claude", "anthropic", "cowork", "claude code"];
  }

  protected extraCapabilities(): Partial<ProviderCapabilities> {
    return { runTask: "api" };
  }

  protected extraNotes(): CapabilityNotes {
    return {
      listTasks: undefined,
      createTask: "Anthropic documents no API for creating routines; create them at claude.ai/code/routines or with /schedule in Claude Code.",
      updateTask: "Anthropic documents no API for editing routines; edit them at claude.ai/code/routines.",
      cancelTask: "Anthropic documents no API for pausing routines; use the switch at claude.ai/code/routines.",
      runTask: "A routine with an API trigger can be started through its fire endpoint once its URL and token are added to the task's configuration (fire_url, fire_token).",
      getRun: "Anthropic documents no API for reading a routine's runs; open the run session on claude.ai.",
      subscribeEvents: "Claude Code routines and Cowork can report back through the MCP reporter or the ingest API (see examples/).",
    };
  }

  canRunTask(task: TaskRef): { ok: boolean; reason?: string } {
    const url = task.configuration.fire_url;
    const token = task.configuration.fire_token;
    // The real trigger is https only; plain http is accepted for a loopback stand-in in tests.
    const acceptable = typeof url === "string" && (/^https:\/\//.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url));
    if (acceptable && typeof token === "string" && token) return { ok: true };
    return { ok: false, reason: "Add the routine's API trigger to this task: its fire URL (fire_url) and token (fire_token) from claude.ai/code/routines › Edit › API." };
  }

  /** Start a routine through its API trigger. The run continues on Anthropic's cloud; the session URL is where to watch it. */
  async runTask(task: TaskRef, _ctx: ExecutionContext, input: RunTaskInput = {}): Promise<RunTaskResult> {
    const can = this.canRunTask(task);
    if (!can.ok) return { ok: false, message: can.reason ?? "not configured" };
    const url = String(task.configuration.fire_url);
    const token = String(task.configuration.fire_token);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "anthropic-beta": CLAUDE_ROUTINE_BETA, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(input.text ? { text: input.text } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { claude_code_session_id?: string; claude_code_session_url?: string; error?: { message?: string } };
      if (!res.ok) return { ok: false, message: `Claude answered ${res.status}: ${body.error?.message ?? "routine could not be started"}` };
      return { ok: true, external_id: body.claude_code_session_id ?? null, url: body.claude_code_session_url ?? null, message: body.claude_code_session_url ? `Started at Claude. Watch it at ${body.claude_code_session_url}` : "Started at Claude." };
    } catch (err) {
      return { ok: false, message: `Could not reach Claude's routine trigger: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
