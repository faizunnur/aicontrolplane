# AI Control Plane

Connect your AIs once. Tell them what to do from one chat. Watch them from one dashboard.

You use ChatGPT, Claude, Grok and maybe others, each with its own site, its own scheduled tasks, its own
notifications. This app puts all of them behind one screen. It runs a real browser in the cloud that stays
signed in to each AI as you, so it can send your instructions and read the answers back without you visiting
any of those sites.

```
  AIs & chats          Conversation                          Live browser
  ───────────────      ──────────────────────────────────    ─────────────────────────────
  ● ChatGPT            you:  Grok, what's trending in AI?    [ChatGPT] [Grok]   ← → ⟳  🔒 grok.com
  ● Claude                   ✓ Opening Grok                  ┌───────────────────────────┐
  ○ Grok  signed out         ✓ Typing your message           │  the agent typing, live,  │
                             ● Waiting for Grok to answer    │  as it happens            │
  Today                Grok: Three things today: …           │                           │
    Weekly report                                            └───────────────────────────┘
    Trending in AI     [Auto ▾]  Message your AIs…      ↑    Live · Grok · 24 fps
```

## The workspace

One screen, three panels. Drag the dividers to resize them, collapse the sides when you want room, and on a
phone they become three tabs.

**Left: your AIs and your chats.** Each AI with its connection state, what the agent is doing with it right
now, and a menu to sign in, check, show its tab or edit it. Under that, the cloud browser and routing status,
then every chat you have had, grouped by day.

**Middle: the conversation.** Chat normally or give an instruction. It goes to the AI you name or pick
("Grok, what's trending?", or tap its chip), and the answer comes back in the thread. While the agent works,
its activity appears under your message as it happens: Opening ChatGPT → Checking the sign-in → Typing your
message → Sending → Waiting for the answer → Reading the answer → Done. A Stop button ends a task early.

**Right: the live browser.** The actual browser the agent uses, streamed as it happens, one tab per AI. You
can watch every action, and when nothing is running you can click, type and scroll in it yourself. The address
bar, back, forward and reload work like any browser. "Follow agent" keeps the panel on whichever tab the agent
is working in. Signing in to an AI happens right here.

**Two execution modes**, switched in the conversation header:

- **Auto approve.** The agent performs every action on its own.
- **Ask me first.** The agent types the message, then pauses and asks in the thread. You watch it sitting in the
  AI's box in the live browser, then press Approve or Reject. Custom actions ask the same way. An approval that
  nobody answers within 15 minutes is treated as a rejection.

Everything else lives behind the gear icon.

## Run it

### On Railway (recommended)

1. Create a service from this repository. The `Dockerfile` and `railway.toml` are picked up automatically.
2. Keep your data between deploys, one of two ways:
   - **Postgres (easiest).** Add a Postgres database to the project and, in this service's variables, add
     `DATABASE_URL` referencing it (`${{Postgres.DATABASE_URL}}`). Sign-ins, chats and settings are mirrored
     there and restored on every boot. No volume needed.
   - **Volume.** Attach a volume mounted at `/data`.
   Without either, every deploy signs you out and the dashboard shows a warning banner.
3. Do not set `DATA_DIR` on Railway; the image already uses `/data`.
4. Give the service at least 2 GB of memory (it runs Chromium; "Page crashed" means it needs more) and generate a domain.
5. Open the domain. Create your password. Open the menu next to an AI on the left, press Sign in, and sign in
   inside the browser panel. That's it.

Optional variables, all set in the Railway service:

| Variable | What it does |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Lets Claude decide which AI should get an instruction when several are connected and you didn't name one. Get it with `claude setup-token` on your laptop. Uses your Claude subscription. |
| `ANTHROPIC_API_KEY` | Same, billed per token instead. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL` | Get a message when something fails or an AI signs you out. |
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` | Read task notification emails (for example from ChatGPT) into the dashboard. |
| `ACP_ADMIN_TOKEN`, `ACP_INGEST_TOKEN` | Only if you prefer to set the password and the agent token on the server instead of in the app. |
| `SYNC_INTERVAL_MIN` | How often the dashboard looks at each AI's task page. Default 20. |

The full list with defaults is in `.env.example`.

### Locally

```bash
npm install
npm run dev          # opens http://localhost:8080 with a real Chromium window on your desktop
```

Or the exact image Railway builds: `docker compose up --build`.

## How the routing decides

When you press Enter without choosing an AI:

1. If you named one ("ask Claude…", "Grok, …", "@chatgpt …"), it goes there.
2. If only one AI is connected, it goes there.
3. If several are connected and a Claude credential is configured, Claude picks based on each AI's
   "what you use it for" line (editable on Connect › … › Edit).
4. Otherwise the app matches keywords in that line, and if it still isn't sure it asks you in the thread.

## Keeping sign-ins across redeploys

Sign-ins live in the browser profile under `/data`. With `DATABASE_URL` set, the app mirrors its small state
(the SQLite database with chats, tasks and your password; the AI settings; the sign-in cookies) into one table
in Postgres every minute when something changed and on shutdown, and restores it before starting. With a
volume instead, the same files simply stay on disk. In both cases an automatic backup file is restored into the
browser profile if it ever comes up empty, and Settings › Saved sign-ins lets you download and restore the
sign-ins by hand. Treat that file like a password.

## When a site changes its layout

The app drives each AI's website through a handful of selectors (the message box, the send button, where
replies appear). If a site redesigns and chat stops working for it, open Settings › AI setup, pick the AI and
update those fields. Restore defaults brings back the built-in values.

## For your own agents (optional)

Anything you build that can make an HTTP call can report runs to the dashboard and pick up instructions you
type in Chat. The token is under Settings › Developer; `examples/` has a shell script, a Claude Code routine
prompt block and an MCP server for Claude Cowork.

```bash
curl -X POST https://your-app.up.railway.app/api/ingest \
  -H "Authorization: Bearer <token from Settings>" \
  -H "Content-Type: application/json" \
  -d '{ "agent": { "key": "nightly-audit", "platform": "custom", "name": "Nightly audit" },
        "run": { "status": "success", "summary": "0 issues found" } }'
```

## How the live browser works

The right panel is not a video of a screen. The app asks Chromium for a screencast of the tab (a JPEG for
every repaint, nothing while the page is still) and streams it over a WebSocket at `/live`; your clicks, keys
and scrolling go back the same way and are replayed in the tab. The picture quality button trades sharpness
for bandwidth. While the agent holds the browser the panel is view-only, so a stray click cannot break a task
that is typing; "Take control" overrides that when you need to dismiss something.

Everything the UI shows updates over server-sent events (`/api/stream`): message steps, replies, connection
state, which tab the agent is in. Nothing polls.

`/vnc/` still exists as a fallback view of the whole screen (the pop-out button), for phones and for the rare
site that misbehaves under the screencast.

## Security notes

- The app holds live sessions for your accounts. Keep it private: your own password, HTTPS only, don't share the link.
- Your Claude subscription token, if you use one, is for your own use; do not expose the app to other people.
- These are consumer accounts driven from one extra browser. The app talks to each AI the way you would, at a
  human pace.
