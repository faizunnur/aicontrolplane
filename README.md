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

## Signing in: live view, cloud desktop, or from your computer

Most providers let you sign in inside the live view. Some guard their sign-in page with a bot check that scores
the browser and the machine it runs on. The app has three ways in, and picks the right one on its own when it
sees a check fail:

- **Live view** (default): the provider's site opens in its automated tab and you sign in through the stream.
- **Cloud desktop**: the automation closes its browser, opens the same profile in a plain Google Chrome window on
  the cloud display, with no debugging session and no automation flags, and shows you that window. You sign in
  as you would at home, press "I'm signed in", the window closes, and the automation takes the profile back with
  your session in it. This is enough for checks that object to automation.
- **From your computer**: for checks that refuse any browser in a datacenter (Grok's accounts.x.ai does, even to
  a plain window). Open the provider's menu, choose "Connect from this computer", and run the one-line command
  the panel shows, on whichever computer you want to sign in from:

  ```bat
  :: Windows, in Command Prompt or PowerShell: both lines
  curl.exe -fsSL https://your-app.up.railway.app/connect.mjs -o acp-connect.mjs
  node acp-connect.mjs https://your-app.up.railway.app ABCD-EFGH
  ```
  ```bash
  # macOS or Linux
  curl -fsSL https://your-app.up.railway.app/connect.mjs -o acp-connect.mjs && node acp-connect.mjs https://your-app.up.railway.app ABCD-EFGH
  ```

  **No copy of this project is needed.** The deployment serves the helper itself, as one plain file with no
  dependencies: anyone you hand the app to can sign in from their own laptop with nothing installed but
  [Node 22 or newer](https://nodejs.org) and a Chrome-family browser (Chrome, Edge, Brave or Chromium). If you
  do have the project folder, `npm run connect -- <url> <code>` runs the same file.

  The panel fills in your deployment's address for you, so the command is ready to paste with nothing to edit.
  It uses `PUBLIC_URL` when that is set (a bare domain is fine), else the domain your host reports, else the
  address you opened the app on. The panel names which of the three it used, so a wrong one is never silent.

  Your browser opens a plain window on the sign-in page, with nothing attached to it. You sign in as you always
  do, including through Google or another provider if that is how you sign in. When the site shows you signed in,
  the helper reads that one provider's cookies and localStorage, sends them to your deployment over HTTPS, and
  the cloud browser is signed in. The panel in the app follows every step and ends with "connected". Grok starts
  in this mode; any provider that needed it once uses it next time, and a sign-out notification says so.

  The code is good for ten minutes and works once. It buys a token that can do exactly one thing, hand that one
  provider's session over, for twenty minutes, once. Both are stored hashed; every step is in the audit log.
  The helper never writes your session to disk; the browser profile it opens lives under
  `~/.aicontrolplane/connect-profile` and can be deleted at any time.

Nothing here pretends to be a different browser or solves a check for you. The desktop mode removes the automation
from the moment you type your password; the connect mode removes the datacenter too. The old manual path
(`npm run login`, then `npm run push-state`, or Settings › Saved sign-ins › Restore) still works as a fallback.

The Docker image installs Google Chrome and uses it for the cloud modes, so sites see an ordinary browser and the
profile never changes hands between two browser versions.

A desktop sign-in belongs to the server, not to the page that started it. If you close or reload the tab while
one is open, the page picks it up again when it loads: the desktop window comes back with "I'm signed in" and
"Cancel", the provider's menu on the left offers "Continue the sign-in" and "Cancel the sign-in", and asking
to sign in to the same provider again joins the window already open rather than being refused. A sign-in left
alone ends on its own after `DESKTOP_SIGNIN_TIMEOUT_MIN` minutes and the automation takes the browser back.
While the window is open, other browser work (a message to an AI, a look at a tasks page) is refused with that
reason instead of waiting behind it, and the scheduled sync skips its turn.

## Talking to the control plane

The command panel is a conversation with the control plane itself, not with one of the AIs. Ask what is
running, what failed today, what needs your approval, or how an agent has been doing, and the answer is read
from your own runs and tasks. Tell it to run, pause, resume or stop a task, or to approve or reject a request,
and it does that here. Greetings and "what can you do?" are answered here as well. Anything else goes to the AI
you name, or to the best fit among the ones you have connected.

Set `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) and those answers are written by Claude rather than
assembled from templates: it sees what the control plane just found or did, a briefing of your current state
and the conversation so far, and it answers like an assistant who runs your agents. It cannot invent a run,
change an outcome or decide an approval; those are settled in code before it is asked, and anything it cannot
phrase falls back to the written sentence. The status block at the bottom of the sidebar says which of the two
is in use.

## Execution modes

**Auto approve** lets the agent perform everyday actions on its own. **Ask me first** makes it pause before
sending a message, running a browser action, starting a task or posting to your agent, and wait for your
Approve or Reject in the thread. Both are presets over a policy table (Settings › Approvals): reading a page,
searching and looking at a tasks page always go ahead; modifying a repository asks; deploying to production and
deleting resources always ask and cannot be relaxed. Policy is enforced on the server before anything happens,
and every request is stored. A run waiting for you holds nothing open: it is parked in the database with what
it needs to continue, so it survives restarts and redeploys, and your Approve resumes it on whichever process
picks it up. Requests nobody answers expire after 15 minutes and the run says so.

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

The same Docker images run everywhere; nothing in the code depends on where it is hosted.

| Where | Quick start | Full guide |
|---|---|---|
| **Your computer** | `npm install && npx playwright install chromium && npm run dev`, then open http://localhost:8080 | [docs/local.md](docs/local.md) |
| **Railway** | Deploy this repo, add Postgres, set `DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}` and `ACP_MASTER_KEY`, 2 GB memory, generate a domain | [docs/railway.md](docs/railway.md) |
| **Your own server** | `docker compose -f docker-compose.selfhosted.yml up -d` | [docs/self-hosted.md](docs/self-hosted.md) |

Then open the app, create your account, and sign in to each AI from the menu next to it on the left. For Grok,
the menu offers "Connect from this computer": its sign-in page refuses browsers in a datacenter, so you sign
in on your own machine and the session is handed over.

**Upgrading a Railway deployment that set `DATABASE_URL` before this version?** `DATABASE_URL` used to be a
backup mirror and now means "Postgres is the database". Follow
[Upgrading an existing Railway deployment](docs/railway.md#2-upgrading-an-existing-railway-deployment) before
you deploy, or the new version starts on empty tables.

### One process or several

By default everything runs in one process (`ROLE=all`): one container, SQLite or Postgres, no Redis. When one
container is not enough, the same code runs as three services over Postgres and Redis:

| Service | `ROLE` | Does |
|---|---|---|
| api | `api` | dashboard, API, event stream; only enqueues work, never executes it |
| worker | `worker` | task starts, webhook deliveries, approval resumes, email, sweeps; scale freely |
| browser | `browser` | everything that drives Chrome: chats, syncs, sign-ins, the live view |

Split services need `DATABASE_URL`, `REDIS_URL` and one shared `ACP_MASTER_KEY`, and refuse to start without
them. Every service answers `/healthz` (alive) and `/readyz` (database reachable), and Prometheus metrics at
`/metrics`.

### Settings

Everything is an environment variable; the full list with defaults is in [`.env.example`](.env.example). The
ones worth knowing:

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres as the database. Without it, a SQLite file in the data folder. |
| `ACP_MASTER_KEY` | Encrypts stored secrets (provider cookies, webhook and routine tokens). `openssl rand -hex 32`. Without it a key file is generated in the data folder — fine locally, but on Railway without a volume it is lost on every deploy. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Turns the command panel into a conversation: Claude answers you in its own words from your own state, picks which AI gets a message, and tells a question from an instruction. Uses your Claude subscription; get it with `claude setup-token`. |
| `ANTHROPIC_API_KEY` | Same, billed per token instead. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL` | Get a message when something fails or an AI signs you out. |
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` | Read task notification emails (for example from ChatGPT) into the registry. |
| `ACP_ADMIN_TOKEN`, `ACP_INGEST_TOKEN` | Only if you prefer to set the password and the agent token on the server instead of in the app. |
| `PUBLIC_URL` | The address people reach the app on (alerts, webhook report URLs, the connect command). Taken from Railway's domain when unset there; never guessed from requests. |
| `SYNC_INTERVAL_MIN` | How often the control plane looks at each provider's tasks page. Default 20. |
| `LOG_LEVEL` | What the server prints: `debug`, `info` (default), `warn` or `error`. |

Database migrations run automatically on boot.

**Reading the logs.** The console (what Railway's log shows) prints at `LOG_LEVEL` and above, as one JSON
object per line in production, each carrying the `request_id`, `run_id` and user it belongs to. Every request
that changes something, every run and step, every approval, sign-in and live-view connection is logged at
`info`; page reads and navigation land at `debug`. **Monitoring › Logs** in the app tails the server live, keeps
the last 2000 lines at every level since the server started, filters by level and part, and can raise what the
console prints without a redeploy.

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
  plane. Greetings and "what can you do?" are answered here too, so they never cost a run at a provider.
- **The assistant** (`src/assistant.ts`) gives those answers a voice when a Claude credential exists. The
  control plane decides and acts first; Claude is then handed that outcome, a briefing of your real state and
  the thread so far, and is told to add no facts, change no outcome and decide no approval. Every failure,
  refusal or timeout falls back to the written sentence, so the control plane never depends on a model.
- **Durable execution** (`src/runs.ts`, `src/tasks.ts`, `src/jobs.ts`, `packages/queue`): a run moves through
  queued → running → waiting for approval → finished by guarded database updates, so two processes can never
  both finish it. Work travels as jobs (pg-boss in Postgres when split, in-process otherwise); submissions
  accept an `Idempotency-Key`, so a retried request never starts a task twice. Runs whose process died are
  found by silence and failed visibly; lost jobs are re-sent by a sweep.
- **Data** (`packages/data`): one data layer over SQLite or Postgres. Every announced change is appended to an
  ordered event log, which is what the live views replay from after a reconnect.
- **Live** (`src/live.ts`, `src/browser/live.ts`): server-sent events for state (resuming from `Last-Event-ID`
  after a dropped connection), a WebSocket screencast of the tab the agent works in with input replayed back.
  Between split services both travel over Redis. Chromium keeps one profile; sign-ins are sealed in the
  database and restored into a fresh profile after a redeploy.
- **Logs** (`src/logger.ts`): one logger for every part, printing at `LOG_LEVEL` and keeping the last 2000 lines
  in memory; each line is also sent over the event stream, which is what the Logs view tails (`GET /api/logs`,
  `PUT /api/logs/level`).

## Security notes

- The app holds live sessions for your accounts. Keep it private: your own password, HTTPS only, don't share the link.
- Accounts have an email, a role (owner, admin, member) and an argon2id-hashed password. A login is a random
  session token in an HttpOnly cookie; logout revokes it, a password change revokes them all, and tokens are
  never accepted in URLs. Login attempts are rate limited and audited. Requests that change something from a
  browser session must come from the app's own origin.
- Stored secrets (provider cookies, webhook and routine tokens) are encrypted at rest under `ACP_MASTER_KEY`. A
  leaked database dump without the key exposes no credentials.
- Calls to URLs you or your agents configure (webhooks, routine triggers) refuse private and cloud-metadata
  addresses in production and are pinned to the address that was checked. Webhooking something on your own
  network? List it in `ACP_EGRESS_ALLOWLIST`.
- The live browser socket refuses cross-origin pages; the app pages ship with a content-security policy.
- The ingest token lets your agents register, report, ask and read their inbox. Treat it like a password; rotate it
  under Settings › Developer if it leaks. It cannot read chats, cookies or settings.
- Exporting your saved sign-ins (Settings › Saved sign-ins) is written to the audit log. Treat that file like a password.
- "Connect from this computer" uses a single-use pairing code (ten minutes) and a token scoped to one provider's
  session import (twenty minutes, once). Guessing codes is rate limited; the helper refuses plain HTTP except to
  localhost; the token cannot read or change anything else.
- The connect helper at `/connect.mjs` is served without a password on purpose: it is client code with no secrets
  in it, and it does nothing without a live code. It is one readable file, so anyone can check it before running it.
- These are consumer accounts driven from one extra browser. The app talks to each AI the way you would, at a
  human pace, and never claims an API a provider does not document.
