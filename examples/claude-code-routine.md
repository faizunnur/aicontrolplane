# Wiring a Claude Code routine to the control plane

Claude Code routines run in the cloud and can call any HTTP endpoint, so they can
both **pick up instructions** you typed in the command chat and **report their outcome**.
Give the routine two environment variables, `ACP_URL` (your deployment) and
`ACP_INGEST_TOKEN`, and paste the two blocks below into its prompt. Keep the `key`
stable; it is what ties instructions and runs to the same task in the registry.

Two things the control plane can do with a routine beyond reports:

- **Start it from the control plane.** Add an API trigger to the routine at
  claude.ai/code/routines › Edit › API, then put its fire URL and token on the task
  (`PATCH /api/tasks/:id` with `{"configuration": {"fire_url": "…", "fire_token": "…"}}`,
  or Tasks › the task's menu once the UI exposes it). "Run" and "run the nightly review" then
  fire it through Anthropic's documented endpoint.
- **Show it live.** Instead of one report at the end, open a run with `POST /api/runs`, stream
  what you are doing with `POST /api/runs/:id/events`, and close it with `POST /api/runs/:id/finish`.
  The run then shows as running in the Overview with its current step.

## At the start: fetch instructions

```
Before doing anything else, fetch pending instructions from my control plane:

curl -sS "$ACP_URL/api/inbox?platform=claude&key=nightly-dependency-audit" \
  -H "Authorization: Bearer $ACP_INGEST_TOKEN"

The response has a "messages" array. Treat each "text" as an instruction from me
that applies to this run, in addition to your standing task. When you have
handled an instruction (or cannot), acknowledge it:

curl -sS -X POST "$ACP_URL/api/inbox/<id>/ack" \
  -H "Authorization: Bearer $ACP_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "done", "response": "<one or two sentences on what you did>"}'

Use "status": "failed" with an explanation if you could not do it.
```

## At the end: report the run

```
When you are completely finished, report the outcome with one curl call. Use
status "success" if everything worked, "failed" if you hit an error you could not
recover from, or "needs_attention" if a human has to decide something. Keep the
summary under 300 characters and include a link to the PR, commit or document you
produced when there is one.

curl -sS -X POST "$ACP_URL/api/ingest" \
  -H "Authorization: Bearer $ACP_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": {
      "platform": "claude",
      "key": "nightly-dependency-audit",
      "name": "Nightly dependency audit",
      "schedule": "daily 02:00 UTC",
      "native_url": "https://claude.ai/code",
      "keywords": "dependencies, npm, audit, security, upgrade"
    },
    "run": {
      "status": "<success|failed|needs_attention>",
      "summary": "<one or two sentences>",
      "output_url": "<link to the PR or artifact, or omit>"
    }
  }'
```

The `keywords` field is optional but makes the router more accurate when you type
instructions like "skip the audit tonight" or "also check the Python deps". Add
`"profile": { "key": "my-routines", "name": "My routines" }` next to `"agent"` to group several
routines under one agent in the Agents view; without it the task belongs to Claude's assistant profile.

## Agents that can receive a webhook instead

If your agent has an HTTP endpoint (a Claude Code routine with an API trigger, a
custom service, an n8n or Make flow), set its delivery mode to **webhook** on the
dashboard with that URL. Every instruction is then POSTed immediately as

```json
{ "message_id": 12, "text": "…", "agent": { "key": "…", "name": "…", "platform": "…" }, "created_at": "…", "ack_url": "https://…/api/inbox/12/ack" }
```

and the agent acknowledges through `ack_url` with the same body as above.

The same patterns work for any agent that can run a shell command or make an
HTTP request: Grok Bot routines, ChatGPT agents with a code tool, cron jobs,
GitHub Actions. For agents that cannot call HTTP at all, such as ChatGPT
scheduled tasks, the control plane types the instruction into the platform
through its cloud browser (delivery mode **browser**), or leaves it for you to
copy (**manual**).
