# AI Control Plane

One place to see and manage every AI agent you run, no matter which platform it lives on:
ChatGPT scheduled tasks, Claude Code routines and Cowork, Grok bots, Muse, and anything you build yourself.

Most of those platforms have no API for their task lists or run history. This service works around that
by running a real, logged-in Chromium in the cloud and reading the same web app you use on your laptop.
Anything that *can* call an HTTP endpoint pushes results in directly instead.

```
                    ┌──────────────────────────────────────────────────────┐
   you (browser)    │  AI Control Plane (one Railway service, one volume)  │
   ───────────────► │                                                      │
   dashboard  /     │  dashboard ─── SQLite (agents · runs · events)       │
   /vnc screen      │       ▲              ▲          ▲                    │
                    │       │              │          │                    │
                    │  collector ──► Chromium (persistent profile, Xvfb)   │
                    │   every N min      │  tabs: chatgpt.com  claude.ai   │
                    │   screenshot,      │        grok.com     …           │
                    │   capture JSON     │                                 │
                    │                    │                                 │
   agents ────────► │  POST /api/ingest  │   IMAP poller ◄── notification  │
   (routines, bots, │  (push reports)    │                    emails       │
    cron, MCP)      └──────────────────────────────────────────────────────┘
```

## What you get

- **Registry.** Every agent, on every platform, with purpose, schedule and a deep link to its native console.
- **Live mirror.** For each web platform: session state, a fresh screenshot of its task page, tasks and run
  history extracted from the JSON the app itself fetches, and a text snapshot as a fallback.
- **Push ingest.** `POST /api/ingest` for any agent that can make an HTTP call. Claude Code routines, Grok Bot,
  cron jobs, GitHub Actions, or Cowork through the bundled MCP reporter.
- **Email ingest.** Optional IMAP poller that turns task notification emails (for example from ChatGPT) into events and runs.
- **Attention feed.** Failed runs, sessions that need a login, unread notifications, plus webhook or Telegram alerts.
- **Actions.** Open a task in the cloud browser, refresh its screenshot, and run your own click sequences
  ("Run now", "Pause") defined per platform in settings, without code changes.
- **Browser screen.** noVNC, proxied through the app on the same port and protected by the admin token.
  This is where you log in once, and again whenever a session expires.

## Deploy to Railway

1. Push this folder to a Git repo and create a Railway service from it. The `Dockerfile` and `railway.toml` are picked up automatically.
2. **Add a volume** to the service mounted at `/data`. It holds the browser profile (your logins), the SQLite
   database and screenshots. Without it every redeploy logs you out.
3. Set variables:

   | Variable | Required | Notes |
   |---|---|---|
   | `ACP_ADMIN_TOKEN` | yes | Long random string. Dashboard, API and `/vnc` login. |
   | `ACP_INGEST_TOKEN` | yes | Separate token agents use to push runs. |
   | `PUBLIC_URL` | recommended | `https://<your-service>.up.railway.app`, used in alerts and examples. |
   | `SYNC_INTERVAL_MIN` | no | Default 20. Keep it relaxed; sessions live longer that way. |
   | `ALERT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | Any that are set are used. |
   | `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` | no | Enables email ingestion. See below. |

   The full list with defaults is in `.env.example`.
4. Generate a domain, give the service at least 2 GB of memory (Chromium), and deploy.
5. Open the dashboard, sign in with the admin token, press **Browser screen**, and log in to ChatGPT,
   Claude and Grok in the tabs you see. Close the screen, press **Sync all**.

Alternative login path if the remote screen is awkward: run `npm run login` on your laptop, sign in to
every platform in the window that opens, press Enter, then
`npm run push-state -- https://<your-service>.up.railway.app <ACP_ADMIN_TOKEN>` to upload the session cookies.

## Run locally

```bash
npm install
cp .env.example .env           # set the two tokens at least
npm run dev                    # HEADLESS=false opens a real Chromium window on your desktop
```

Dashboard on `http://localhost:8080`. Log in to the platforms directly in the Chromium window.
To run the exact image Railway builds: `docker compose up --build`, then the browser screen is `http://localhost:8080/vnc/`.

## Tuning a platform

Open **Settings** on a platform card. Everything is stored in `/data/platforms.json`; defaults live in
`src/platforms.ts`. Fields that matter:

- **Tasks page URL.** The page that lists scheduled tasks or bots. Sync navigates here.
- **Capture URL patterns.** Regexes over the URLs of JSON requests the page makes. After a sync, the
  **Discovered JSON endpoints** list in the same dialog shows every JSON call the page made; add a pattern for
  the ones that carry your tasks. The normaliser is structural, so you rarely need to care about exact field names:
  any object with an id, a name and a schedule or run list becomes an agent, and any object with an id, a status
  and a timestamp under it becomes a run.
- **Deep-link template.** `https://…/tasks/{{key}}` so discovered agents link straight to their native page.
- **Session cookie name / domain and login URL patterns.** How "login required" is detected.
- **Custom actions.** JSON map of click sequences run on the platform's tab. Variables: `{{native_url}}`, `{{key}}`,
  `{{name}}`, `{{tasksUrl}}`, `{{appUrl}}`. Step types: `goto`, `click`, `fill`, `press`, `wait`, `waitFor`.

  ```json
  { "run_now": { "label": "Run now", "steps": [
      { "type": "goto", "url": "{{native_url}}" },
      { "type": "click", "selector": "text=Run now" },
      { "type": "waitFor", "selector": "text=Running" } ] } }
  ```

New platforms are just new keys in the same file, or a PUT to `/api/platforms/<id>` with the same shape.

## Push runs from anywhere

```bash
curl -X POST "$PUBLIC_URL/api/ingest" \
  -H "Authorization: Bearer $ACP_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": { "key": "daily-digest", "platform": "claude", "name": "Daily digest", "schedule": "weekdays 08:00" },
    "run":   { "status": "success", "summary": "Sent digest with 12 items", "output_url": "https://..." }
  }'
```

- `agent.key` + `agent.platform` identify the agent. It is created on first report and updated afterwards.
- `run.status` is one of `success`, `failed`, `running`, `needs_attention`, `unknown`. Failed and needs_attention runs raise an event and an alert.
- `run.external_id` makes reports idempotent: reporting the same id again updates the run instead of adding one.
- `event` is an optional `{ title, body, link, kind }` for notifications that are not runs.

Ready-made helpers in `examples/`: `report.sh` for shells and cron, `claude-code-routine.md` for the prompt block
to paste into a Claude Code routine, and `mcp-reporter/` a stdio MCP server exposing `report_run` for Cowork and
Claude Desktop (`cd examples/mcp-reporter && npm install`).

## Email ingestion

Turn on email notifications for tasks on platforms that cannot push (ChatGPT scheduled tasks, for example),
then set `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` (Gmail: an app password, host `imap.gmail.com`). Unseen mails whose
sender domain matches `EMAIL_SENDER_MAP` become events; when the subject or body contains a registered agent's name,
a run is recorded too. The poller marks mails as seen. Use a dedicated mailbox or label if you prefer.

## API

All routes under `/api` need `Authorization: Bearer <ACP_ADMIN_TOKEN>` or the dashboard's session cookie, except
`POST /api/ingest`, which takes the ingest token. `GET /healthz` is public.

| Method & path | What it does |
|---|---|
| `GET /api/overview` | Counts, platform cards with state, attention items, scheduler and browser status |
| `GET/POST /api/agents`, `PUT/DELETE /api/agents/:id` | Registry |
| `GET /api/runs?platform=&status=&agent_id=&limit=` | Run history |
| `GET /api/events?unread=1`, `POST /api/events/:id/read`, `POST /api/events/read-all` | Attention feed |
| `GET /api/platforms`, `GET /api/platforms/:id`, `PUT /api/platforms/:id`, `DELETE /api/platforms/:id/overrides` | Platform config, discovered endpoints, recent captures |
| `POST /api/sync`, `POST /api/platforms/:id/sync` | Sync all or one platform now |
| `POST /api/platforms/:id/actions/:action` `{agent_id?}` | Built-ins `open`, `screenshot`, `sync`, plus custom actions |
| `GET /api/platforms/:id/screenshot.png`, `GET /api/platforms/:id/captures`, `GET /api/captures/:id` | Evidence |
| `GET /api/browser`, `POST /api/browser/open`, `GET /api/browser/export-state`, `POST /api/browser/import-state` | Browser control and session transfer |
| `POST /api/email/poll`, `POST /api/alerts/test` | Manual triggers |
| `/vnc/` | noVNC screen of the cloud browser |

## How the collector stays reliable

- One persistent Chromium profile on the volume, one long-lived tab per platform. Logins survive restarts and redeploys.
- Sync reads the JSON the web app fetches for itself rather than scraping the DOM, and falls back to a text snapshot and a screenshot, so you always get *something* even when a platform ships a redesign.
- Login state is detected three ways: redirect to a login URL, missing session cookie, or a 401 on a captured call. A transition to "login required" creates an event and an alert once, not every sync.
- The scheduler pauses while someone is connected to the browser screen, so a sync never yanks the tab out from under you mid-login.
- A stalled first navigation is retried once on a fresh tab. Stale Chromium lock files are removed at launch.

## Security notes

- The volume holds live sessions for your accounts. Treat it like a password store: private project, strong admin token, HTTPS only.
- The dashboard session cookie is HttpOnly and only ever carries a hash of the admin token. Agents get the separate ingest token and nothing else.
- These are personal consumer accounts driven from one extra browser. Keep the sync interval relaxed and the usage read-mostly.

## Troubleshooting

- **Card says "login required" right after you logged in.** Press Sync again; the check runs on the next visit. If it persists, the cookie name in Settings may be wrong for that platform: clear the *Session cookie name* field to rely on redirect detection only.
- **Signed in but 0 agents.** Open Settings and look at *Discovered JSON endpoints*. Add a capture pattern for the call that returns your tasks. The screenshot and text snapshot still show the page meanwhile.
- **Browser screen shows 502.** The service is running with `HEADLESS=true` or outside the Docker image. The screen needs Xvfb, which the image provides.
- **Chromium keeps restarting on Railway.** Raise the service memory. Two or three platform tabs need roughly 1.5 GB.
