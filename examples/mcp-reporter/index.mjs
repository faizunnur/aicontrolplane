#!/usr/bin/env node
/**
 * MCP server (stdio) exposing one tool, `report_run`, that posts to the control
 * plane's ingest API. Wire it into Claude Cowork / Claude Desktop and end each
 * scheduled task's instructions with "call report_run with the outcome".
 *
 * Config (claude_desktop_config.json or Cowork connector settings):
 * {
 *   "mcpServers": {
 *     "acp-reporter": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/examples/mcp-reporter/index.mjs"],
 *       "env": { "ACP_URL": "https://your-app.up.railway.app", "ACP_INGEST_TOKEN": "..." }
 *     }
 *   }
 * }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ACP_URL = (process.env.ACP_URL || "").replace(/\/$/, "");
const ACP_INGEST_TOKEN = process.env.ACP_INGEST_TOKEN || "";
const DEFAULT_PLATFORM = process.env.ACP_PLATFORM || "claude";

const server = new McpServer({ name: "acp-reporter", version: "0.1.0" });

server.registerTool(
  "report_run",
  {
    title: "Report a task run to the AI Control Plane",
    description:
      "Record the outcome of a scheduled task or agent run so it shows up on the single control plane dashboard. Call this once, at the very end of a task.",
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
    if (!ACP_URL || !ACP_INGEST_TOKEN) {
      return { isError: true, content: [{ type: "text", text: "ACP_URL and ACP_INGEST_TOKEN are not configured for this MCP server." }] };
    }
    const body = {
      agent: {
        key: input.agent_key,
        name: input.agent_name,
        platform: input.platform || DEFAULT_PLATFORM,
        schedule: input.schedule,
      },
      run: {
        status: input.status,
        summary: input.summary,
        details: input.details,
        output_url: input.output_url,
        finished_at: new Date().toISOString(),
      },
    };
    const res = await fetch(`${ACP_URL}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ACP_INGEST_TOKEN}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { isError: true, content: [{ type: "text", text: `Control plane rejected the report (${res.status}): ${text}` }] };
    return { content: [{ type: "text", text: `Reported ${input.status} for ${input.agent_key}.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
