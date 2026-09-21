# AI Control Plane

Connect your AIs once. Tell them what to do from one chat. Watch them from one dashboard.

You use ChatGPT, Claude, Grok and maybe others, each with its own site, its own scheduled tasks, its own
notifications. This app puts all of them behind one screen. It runs a real browser in the cloud that stays
signed in to each AI as you, so it can send your instructions and read the answers back without you visiting
any of those sites.

```
   Connect            Chat                                  Dashboard
   ────────           ─────────────────────────────────     ───────────────────────
   ChatGPT  ● on      you:  Grok, what's trending in AI?    ● ChatGPT   3 tasks, ok
   Claude   ● on      Grok: Three things today: …           ● Claude    2 tasks, ok
   Grok     ● on      you:  Draft the weekly report         ● Grok      1 failed ← needs you
   + add another      Claude: Here is a draft: …            activity · attention
```

## Three screens

**Connect.** One row per AI with a Connect button. It opens that AI's sign-in page on a private screen inside
the app. You sign in the way you always do, press "I'm signed in", and it stays signed in from then on.
Add any other AI with a name and its web address.

**Chat.** One thread. Type an instruction and press Enter. The app picks the AI (or you tap a chip to choose),
opens a conversation there, types your instruction, waits for the answer and posts it back in the thread.
Name an AI to be explicit: "Grok, what's trending?" Anything the AI does in the background, like a scheduled
task it creates, shows up on the Dashboard later.

**Dashboard.** One card per AI: connected or not, the tasks it is running with their last result, a live
screenshot, and a Refresh button. Above the cards, whatever needs you: an AI that signed you out, an
instruction that could not be sent, a task that failed.

Everything else lives behind the gear icon.

## Run it

### On Railway (recommended)

1. Create a service from this repository. The `Dockerfile` and `railway.toml` are picked up automatically.
2. Add a **volume mounted at `/data`**. That is where your sign-ins live. Without it every deploy signs you out,
   and the app will show a warning banner.
3. Give the service at least 2 GB of memory (it runs Chromium) and generate a domain.
4. Open the domain. Create your password. Go to Connect and sign in to your AIs. That's it.

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

Sign-ins live in the browser profile under `/data`. Three layers protect them: the volume, an automatic backup
file the app restores from if the profile ever comes up empty, and Settings › Saved sign-ins where you can
download the file and restore it later. Treat that file like a password.

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

## Security notes

- The app holds live sessions for your accounts. Keep it private: your own password, HTTPS only, don't share the link.
- Your Claude subscription token, if you use one, is for your own use; do not expose the app to other people.
- These are consumer accounts driven from one extra browser. The app talks to each AI the way you would, at a
  human pace.
