#!/usr/bin/env node
/**
 * MCP server (stdio) that connects Claude Cowork / Claude Desktop to the control plane.
 * Three tools:
 *   get_instructions      - fetch instructions you sent from the dashboard to this agent
 *   complete_instruction  - mark one done or failed, with a short response
 *   report_run            - record the outcome of a task run
 *
 * Config (claude_desktop_config.json or Cowork connector settings):
 * {
 *   "mcpServers": {
 *     "acp": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/examples/mcp-reporter/index.mjs"],
 *       "env": { "ACP_URL": "https://your-app.up.railway.app", "ACP_INGEST_TOKEN": "...", "ACP_PLATFORM": "claude" }
 *     }
 *   }
 * }
 *
 * End each scheduled task's instructions with:
 *   "First call get_instructions for agent_key <key>. Carry out anything pending, call
 *    complete_instruction for each, then call report_run with the outcome."
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ACP_URL = (process.env.ACP_URL || "").replace(/\/$/, "");
const ACP_INGEST_TOKEN = process.env.ACP_INGEST_TOKEN || "";
const DEFAULT_PLATFORM = process.env.ACP_PLATFORM || "claude";

const server = new McpServer({ name: "acp", version: "0.2.0" });
const headers = { "content-type": "application/json", authorization: `Bearer ${ACP_INGEST_TOKEN}` };
const notConfigured = { isError: true, content: [{ type: "text", text: "ACP_URL and ACP_INGEST_TOKEN are not configured for this MCP server." }] };

server.registerTool(
  "get_instructions",
  {
    title: "Fetch pending instructions from the AI Control Plane",
    description: "Returns instructions the user sent to this agent from the control plane dashboard. Call it at the start of a task.",
    inputSchema: {
      agent_key: z.string().describe("Stable id of this agent, e.g. 'weekly-competitor-digest'"),
      platform: z.string().optional().describe("Platform id, defaults to ACP_PLATFORM or 'claude'"),
    },
  },
  async (input) => {
    if (!ACP_URL || !ACP_INGEST_TOKEN) return notConfigured;
    const url = `${ACP_URL}/api/inbox?platform=${encodeURIComponent(input.platform || DEFAULT_PLATFORM)}&key=${encodeURIComponent(input.agent_key)}`;
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) return { isError: true, content: [{ type: "text", text: `Control plane responded ${res.status}: ${text}` }] };
    const data = JSON.parse(text);
    if (!data.messages?.length) return { content: [{ type: "text", text: "No pending instructions." }] };
    const lines = data.messages.map((m) => `#${m.id} (${m.created_at}): ${m.text}`);
    return { content: [{ type: "text", text: `Pending instructions:\n${lines.join("\n")}\n\nCall complete_instruction with each id when handled.` }] };
  },
);

server.registerTool(
  "complete_instruction",
  {
    title: "Mark an instruction done or failed",
    description: "Tell the control plane what happened with an instruction fetched via get_instructions.",
    inputSchema: {
      message_id: z.number().int().describe("The #id returned by get_instructions"),
      status: z.enum(["done", "failed", "acknowledged"]).default("done"),
      response: z.string().max(4000).optional().describe("One to three sentences on what you did or why it failed"),
    },
  },
  async (input) => {
    if (!ACP_URL || !ACP_INGEST_TOKEN) return notConfigured;
    const res = await fetch(`${ACP_URL}/api/inbox/${input.message_id}/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: input.status, response: input.response }),
    });
    const text = await res.text();
    if (!res.ok) return { isError: true, content: [{ type: "text", text: `Control plane responded ${res.status}: ${text}` }] };
    return { content: [{ type: "text", text: `Instruction #${input.message_id} marked ${input.status}.` }] };
  },
);

server.registerTool(
  "report_run",
  {
    title: "Report a task run to the AI Control Plane",
    description: "Record the outcome of a scheduled task or agent run so it shows up on the control plane dashboard. Call this once, at the very end of a task.",
    inputSchema: {
      agent_key: z.string().describe("Stable id for this task, e.g. 'weekly-competitor-digest'"),
      agent_name: z.string().optional().describe("Human readable name"),
      status: z.enum(["success", "failed", "running", "needs_attention"]).describe("Outcome of the run"),
      summary: z.string().max(4000).describe("One to three sentences on what happened"),
      output_url: z.string().url().optional().describe("Link to the produced document, PR, or chat"),
      platform: z.string().optional().describe("Platform id, defaults to ACP_PLATFORM or 'claude'"),
      schedule: z.string().optional().describe("Human readable cadence, e.g. 'weekdays 09:00'"),
      details: z.string().max(50000).optional().describe("Longer log or notes"),
    },
  },
  async (input) => {
    if (!ACP_URL || !ACP_INGEST_TOKEN) return notConfigured;
    const body = {
      agent: { key: input.agent_key, name: input.agent_name, platform: input.platform || DEFAULT_PLATFORM, schedule: input.schedule },
      run: { status: input.status, summary: input.summary, details: input.details, output_url: input.output_url, finished_at: new Date().toISOString() },
    };
    const res = await fetch(`${ACP_URL}/api/ingest`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) return { isError: true, content: [{ type: "text", text: `Control plane rejected the report (${res.status}): ${text}` }] };
    return { content: [{ type: "text", text: `Reported ${input.status} for ${input.agent_key}.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
