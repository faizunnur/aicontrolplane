# The desktop connector

The connector is the part of the desktop app that does the work: it runs Chrome on your own
computer for your workspace and talks to the cloud control plane over one WebSocket (the
gateway, `/gw`). While it is connected, it *is* your workspace's browser: sign-in checks and
chat messages run in its Chrome, its steps and screenshots show in the web app, and the live
view streams its tabs. Your provider sign-ins never leave the computer.

Today it ships as a plain Node process (`apps/connector`); the windowed app around it is the
next stage of [docs/desktop-plan.md](desktop-plan.md).

## Pair a computer

1. In the web app (as an owner or admin): create a device and copy its token. Until the
   Settings page has a Devices section, use the API:

   ```sh
   curl -X POST https://your-app/api/devices -H "Cookie: <your session>" \
        -H "Content-Type: application/json" -d '{"name":"My laptop"}'
   # → { "device": { "id": 3, "name": "My laptop", ... }, "token": "acp_dev_…", "gateway": "wss://your-app/gw" }
   ```

   The token is shown once. Revoke a device with `DELETE /api/devices/3`; its socket is cut at once.

2. On the computer, with the repository checked out and `npm install` done:

   ```sh
   ACP_URL=https://your-app ACP_DEVICE_TOKEN=acp_dev_… npm run connector
   ```

   It finds your installed Chrome (or falls back to the bundled Chromium), opens a real window
   when a provider needs one, keeps its profile under `~/.aicontrolplane/connector`, and
   reconnects by itself when the line drops. `GET /api/devices` shows it online.

## Settings

| Variable | Meaning |
|---|---|
| `ACP_URL` | The cloud's address. Required. |
| `ACP_DEVICE_TOKEN` | The device token. Required. A refused token (revoked, or from another install) stops the connector; pair again. |
| `DATA_DIR` | Chrome profile, session backups, screenshots. Default `~/.aicontrolplane/connector`. |
| `HEADLESS` | `true` for a windowless Chrome (tests). Leave unset on a desktop: a real window passes bot checks that a headless one fails. |
| `BROWSER_CHANNEL` | `chrome` to prefer the installed Google Chrome (recommended). |
| `PORT` | When set, `GET 127.0.0.1:PORT/healthz` reports `{ connected, org }` for a shell or a test harness. |
| `LOG_LEVEL` | `info` by default. |

## What runs where

| Work | Where it runs while the connector is online |
|---|---|
| Sign-in check, chat message, open a page, screenshot | The connector's Chrome |
| Run bookkeeping (runs, steps, approvals, messages, audit) | The cloud, from the frames the connector sends |
| Reading providers' task pages (sync), configured actions | Not on the connector yet; the cloud's browser service if one runs |
| Anything when the connector is offline | Today: an error, "your computer is not connected" (503). Parking the run until the computer returns is Stage 3. |

Only one connector per workspace is active at a time; a newer connection supersedes the older.

## How it fits together

```
web app ──/api──▶ cloud ──/gw job──▶ connector ──▶ your Chrome ──▶ chatgpt.com …
                   ▲                    │
                   └── run-event · platform · capture · screenshot · state · frames
```

- Protocol: `packages/core/src/gateway.ts`. Cloud side: `src/gateway/`. Connector side:
  `packages/connector/src/{client,host,ops}.ts`, entry `apps/connector/src/main.ts`.
- The browser code is shared unchanged; it reaches the outside world only through the host
  seam (`src/browser/host.ts`), which the connector implements over the socket.
- Tests: `test/e2e/gateway.test.ts` (a stand-in connector) and `test/e2e/connector.test.ts`
  (the real process, headless Chromium, the mock AI site).
