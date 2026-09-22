# AI Control Plane

Mission control for your AI workers. One screen that answers: what is running, what is scheduled, what
finished, what failed, what needs my attention, which agent is working, on which provider, what is it doing
right now, what needs my approval, and what was the result.

You use ChatGPT, Claude, Grok, Gemini and agents of your own, each with its own site, its own scheduled
tasks, its own notifications. This app puts all of them behind one control plane. The providers are
execution backends; the control plane owns the state, the orchestration, the approvals, the observability
and the one interface you look at.

```
                 AI CONTROL PLANE
                        │
                   ORCHESTRATOR          command chat · policies · registry
                        │
        ┌───────────────┼───────────────┐
      AGENTS          TASKS            RUNS       who works · standing work · one execution
        └───────────────┼───────────────┘
                     EVENTS               the timeline of every run
                        │
                    PROVIDERS             ChatGPT · Claude · Grok · Gemini · your own agents
              ┌─────────┼─────────┐
             API       MCP     Browser    each provider through whatever it verifiably supports
```

## The workspace

Three panels. Drag the dividers, collapse the sides, and on a phone they become three tabs.

**Left: navigation and connections.** Overview · Command · Work (Agents, Tasks, Runs, Approvals) ·
Monitoring (Activity, Notifications) · Connections (each provider with its sign-in state and what the agent
is doing with it, plus your custom agents) · Chats.

**Middle: the view you picked, or the command chat.**

- **Overview** answers at a glance: agents active, tasks running, awaiting approval, failed today, completed
  today, scheduled. Then what is running now with its current step, what requires attention (approvals to
  decide, providers to sign in to, failures to dismiss), what is coming up, and what ran recently.
- **Agents** are who does the work: each provider's built-in assistant, the programs you register, and the
  control plane itself for the looks and actions it performs on your behalf.
- **Tasks** is the unified registry: every standing piece of work across every provider, with its agent,
  schedule, next run, last result, whether it is running now, and what can be done to it from here. When a
  provider offers no way to start, pause or edit a task, the button is disabled and the reason is spelled out.
- **Runs** is every execution, of any kind: a message to an AI, a look at a provider's tasks page, an action, a
  task started from here, a run reported by your agent. Open one and its timeline unfolds.
- **Approvals** shows what is waiting for you and what you decided.
- **Activity** is the unified feed: `21:42 Claude · Message to Claude · Opening Claude`, and so on, across every
  run. **Notifications** are the failures, sign-outs and interrupted approvals.
- **Command** is the chat. Ask the control plane and it answers from its own state, never by typing into a
  provider: "What is running?", "What failed today?", "What requires my approval?", "What did Claude complete?",
  "Summarize everything my agents did today." Tell it to act: "Run the security scan again", "Pause the Grok
  monitoring task", "Continue the Claude research task", "approve it". Anything else goes to the AI you name or
  pick, the answer comes back in the thread, and the agent's steps appear under your message as they happen.

**Right: live execution.** The actual browser the agent uses, streamed as it happens. Above the viewport, the
execution header: which agent, on which provider, which task, the current action, the elapsed time, and a
Stop button. When nothing is running you can click, type and scroll in the tab yourself; signing in to a
provider happens right here.

## Execution modes

**Auto approve** lets the agent perform everyday actions on its own. **Ask me first** makes it pause before
sending a message, running a browser action, starting a task or posting to your agent, and wait for your
Approve or Reject in the thread. Both are presets over a policy table (Settings › Approvals): reading a page,
searching and looking at a tasks page always go ahead; modifying a repository asks; deploying to production and
deleting resources always ask and cannot be relaxed. Policy is enforced on the server before anything happens,
every request is stored, and a server restart never drops one silently: whatever was waiting is marked
interrupted, its run needs attention, and you are told.

## What each provider can do

Verified against each provider's documentation on 2026-09-22; declared as capability flags, never assumed.

| Provider | Chat | List tasks | Start a task | Pause / edit tasks |
|---|---|---|---|---|
| ChatGPT | browser | browser (chatgpt.com/schedules) | no public API | no public API |
| Claude | browser | browser (claude.ai/code/routines) | routine API trigger (research preview), when the task holds its fire URL and token | no public API |
| Grok | browser | browser | no management API | no management API |
| Gemini | browser (selectors untested) | set the scheduled-actions page address first | no public API | no public API |
| Your own agents | n/a | they register | their webhook | they own their lifecycle |

An operation a provider cannot do returns a structured `501 unsupported_operation` with the reason, and the UI
hides or disables the control. Provider-specific selectors and rules live in `src/providers/`, nowhere else.

## Run it

### On Railway (recommended)

1. Create a service from this repository. The `Dockerfile` and `railway.toml` are picked up automatically.
2. Keep your data between deploys, one of two ways:
   - **Postgres (easiest).** Add a Postgres database to the project and, in this service's variables, add
     `DATABASE_URL` referencing it (`${{Postgres.DATABASE_URL}}`). Sign-ins, chats and settings are mirrored
     there and restored on every boot. No volume needed.
   - **Volume.** Attach a volume mounted at `/data`.
   Without either, every deploy signs you out and the Overview shows a warning.
3. Do not set `DATA_DIR` on Railway; the image already uses `/data`.
4. Give the service at least 2 GB of memory (it runs Chromium) and generate a domain.
5. Open the domain. Create your password. Open the menu next to a provider on the left, press Sign in, and
   sign in inside the browser panel. That's it.

Optional variables, all set in the Railway service:

| Variable | What it does |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Lets Claude pick which AI gets a message when several are connected, and double-check whether a message is a question for the control plane. Get it with `claude setup-token`. |
| `ANTHROPIC_API_KEY` | Same, billed per token instead. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL` | Get a message when something fails or an AI signs you out. |
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` | Read task notification emails (for example from ChatGPT) into the registry. |
| `ACP_ADMIN_TOKEN`, `ACP_INGEST_TOKEN` | Only if you prefer to set the password and the agent token on the server instead of in the app. |
| `SYNC_INTERVAL_MIN` | How often the control plane looks at each provider's tasks page. Default 20. |

The full list with defaults is in `.env.example`. Database migrations run automatically on boot.

### Locally

```bash
npm install
npm run dev          # http://localhost:8080 with a real Chromium window on your desktop
npm test             # unit tests (fast, no browser)
npm run test:e2e     # spawns the server with headless Chromium against a mock provider
```

Or the exact image Railway builds: `docker compose up --build`.

## For your own agents

Anything that can make an HTTP call appears in the control plane next to ChatGPT, Claude and Grok. The token
is under Settings › Developer; use it as `Authorization: Bearer <token>`.

```bash
# register once
POST /api/agents/register     { "key": "scanner-bot", "name": "Scanner bot", "description": "…", "capabilities": ["scan"] }

# report a finished run of a task (creates the task on first sight)
POST /api/ingest              { "agent": { "key": "repo-scan", "platform": "custom", "name": "Repository scan", "schedule": "nightly" },
                                "profile": { "key": "scanner-bot" },
                                "run": { "status": "success", "summary": "2 PRs opened", "output_url": "https://…" } }

# a live run: open it, stream the timeline, finish it
POST /api/runs                { "agent": { "key": "repo-scan", "platform": "custom" }, "profile": { "key": "scanner-bot" }, "label": "Repository scan" }
POST /api/runs/:id/events     { "key": "scan", "label": "Scanning 12 repositories" }          # later: { "key": "scan", "label": "…", "status": "done" }
POST /api/runs/:id/finish     { "status": "success", "summary": "2 PRs opened" }

# ask before something risky; the answer follows the policy for that action
POST /api/approvals/request   { "action": "deploy_production", "summary": "Deploy build 42" }   →  poll GET /api/approvals/:id

# pick up instructions you typed in the command chat
GET  /api/inbox?platform=custom&key=repo-scan        POST /api/inbox/:id/ack { "status": "done", "response": "…" }
```

Give a task's delivery a `webhook_url` and it can be started from the control plane: it receives
`{ "type": "run_task", "run_id", "task", "text", "report_url" }` and reports back through `report_url`.
Everything the UI shows is also on `GET /api/stream` (server-sent events) for your own tools. `examples/` has a
shell script, a Claude Code routine prompt block and an MCP server for Cowork.

## How it works inside

- **Providers** (`src/providers/`) are adapters with declared capabilities. Built-ins drive their websites through
  `src/providers/browser/` (login detection, chat, task capture with a structural normaliser, configured
  actions) on top of one `PageController`; Claude adds its routine trigger; custom agents are push-only.
- **Tasks** live in the registry (`tasks` table, one row per provider task, attached to an agent profile).
- **Runs** (`runs`) are created by every execution and carry a **timeline** in `run_events`; a message points at
  its run and mirrors the step view for the thread.
- **Policy** (`src/policy.ts`) is the single gate; approvals persist in `approvals`; everything sensitive is
  written to `audit_log`.
- **Intents** (`src/intents.ts`, `src/answers.ts`) keep control-plane questions and commands inside the control
  plane.
- **Live** (`src/live.ts`, `src/browser/live.ts`): server-sent events for state, a WebSocket screencast of the
  tab the agent works in with input replayed back. Chromium keeps one persistent profile per deployment; sign-ins
  are backed up and restored across redeploys.

## Security notes

- The app holds live sessions for your accounts. Keep it private: your own password, HTTPS only, don't share the link.
- A login is a random session token in an HttpOnly cookie; logout revokes it, a password change revokes them all,
  and tokens are never accepted in URLs. Login attempts are rate limited and audited.
- The live browser socket refuses cross-origin pages; the app pages ship with a content-security policy.
- The ingest token lets your agents register, report, ask and read their inbox. Treat it like a password; rotate it
  under Settings › Developer if it leaks. It cannot read chats, cookies or settings.
- Exporting your saved sign-ins (Settings › Saved sign-ins) is written to the audit log. Treat that file like a password.
- These are consumer accounts driven from one extra browser. The app talks to each AI the way you would, at a
  human pace, and never claims an API a provider does not document.
