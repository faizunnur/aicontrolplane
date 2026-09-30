# Desktop-first: the plan

Status: in progress on `feature/desktop`, 2026-09-30.

## Progress

- **Stage 0, done.** The host seam: `src/browser/host.ts` (`ConnectorHost`), `host-local.ts` (the database implementation), the org scope moved to `packages/core/src/scope.ts`. `test/unit/host.test.ts` pins the browser code's import graph free of the database.
- **Stage 1, done for a single-process deployment.** `packages/core/src/gateway.ts` (protocol), `src/gateway/{registry,calls,server}.ts`, `src/devices.ts`, migration 15/109 (`devices`), `GET/POST/DELETE /api/devices`, the `/gw` upgrade. A connected computer takes precedence for its workspace: interactive ops (`callBrowserOp`) and chat deliveries (`performChatSend`) go to it as jobs; its run events, platform state, captures, screenshots and screencast come back; the live view and `/api/browser` show its tabs. `test/e2e/gateway.test.ts` drives all of it with a stand-in connector.
  Not yet: in split mode (`ROLE=api` + workers) the `browser.*` queues are still consumed by the browser role, which holds no connectors, so a workspace with a desktop but no browser service gets no chat delivery there. That is the Stage 3 dispatcher. Offline is still an error (503 "your computer is not connected"), not a parked run.
- Stages 2 to 6: not started.

The product model this plan implements:

| Part | Role |
|---|---|
| Desktop app | Primary experience. Runs the browser work with the user's own Chrome, IP and sign-ins. |
| Cloud control plane | Always on. Source of truth for agents, tasks, runs, approvals, audit, notifications. Routes tasks. |
| Web app | Secondary access from any device: sign-up, results, approvals, monitoring. Same UI files. |
| AI agents and bots | Executors, each in its own environment (vendor cloud, the user's computer, or a custom agent reporting through the ingest API). |

The user's computer does not need to stay on for a task that lives at a vendor or a custom agent. It does for a task that runs on the computer, and the app says so before the user walks away.

---

## 1. Decisions

These are the choices the stages below depend on. Change one and the plan changes.

1. **The cloud is the only database.** The desktop keeps provider sessions and a cache of the last state, nothing else. No second database, no two-way sync.
2. **One UI, two shells.** The Electron window loads the hosted web app (`public/`) from the cloud origin, with a preload bridge that exposes the local connector. No separate desktop UI to build, and UI fixes ship without an app update. The trade-off: no UI while fully offline, only a "you're offline" page and the tray icon. Acceptable for v1.
3. **Electron, not Tauri.** The browser worker is Node and Playwright and runs unchanged inside Electron's main process. Tauri would need a bundled Node sidecar for the same result.
4. **Drive the installed Chrome, never Electron's own Chromium.** `resolveExecutable()` already prefers installed Chrome. The app uses a dedicated profile directory so it never touches the user's own browsing. Fall back to bundled Chromium only with a visible warning, because it scores worse on bot checks.
5. **A gateway, not the bus.** Desktop apps talk to one authenticated WebSocket on the api, locked to their workspace and device. They never see Redis, Postgres or another workspace's traffic.
6. **The browser code gets a "host seam".** Everything the browser code needs from the outside world (run steps, platform state, captures, screenshots, session storage) goes through one interface with two implementations: local database (today) and gateway (desktop). This is the one real refactor in the plan.
7. **Sessions stay on the computer.** Provider cookies are stored with Electron `safeStorage` (OS keychain). The cloud stores only `session_status`, never cookies.
8. **Every provider connection says where it runs.** `runs_on: desktop | cloud`. Every task shows whether it continues when the computer is off.
9. **Offline is a state, not an error.** A run that needs an offline desktop parks as `waiting` with reason `connector_offline`, and resumes when the desktop returns.
10. **Push channels carry results while the computer is off.** Ingest API (exists), vendor notification emails (poller exists, becomes per-workspace), official APIs where they exist (Claude routines fire endpoint). The cloud browser is not the observer any more.
11. **The cloud browser is retired, one release later.** It stays behind `ROLE=browser` / `BROWSER_FLEET` for one release so the current deployment keeps working, then it goes.

---

## 2. Target architecture

```
                         CLOUD (Railway)
   ┌───────────────────────────────────────────────────────────┐
   │  api ──── Postgres ── Redis ── pg-boss queue ── worker     │
   │   │  auth · workspaces · agents · tasks · runs · approvals │
   │   │  router · scheduler (cloud/ingest tasks only)          │
   │   │  ingest API · inbound email · Claude fire API          │
   │   │  /gw  gateway (one socket per desktop, org-locked)     │
   │   │  /live  live view for web viewers (existing)           │
   └───┼───────────────────────────────────────────────────────┘
       │ https (web app, any device)          │ wss /gw (device token)
       ▼                                      ▼
   phone / another PC                  DESKTOP APP (Electron)
   web app: results,                   ┌──────────────────────────┐
   approvals, monitoring               │ window: hosted web app   │
                                       │ + preload bridge         │
                                       │ connector (main process) │
                                       │  · gateway client        │
                                       │  · browser worker code   │
                                       │  · installed Chrome,     │
                                       │    dedicated profile     │
                                       │  · sessions (safeStorage)│
                                       │  · local screencast      │
                                       └──────────────────────────┘
                                                  │ user's own IP
                                                  ▼
                                    chatgpt.com · grok.com · claude.ai · gemini
```

Job flow for a browser-driven task:

```
web/desktop UI → POST /api/chat → router picks provider → run created (cloud)
  → queue job (cloud) → gateway dispatcher: is this org's desktop online?
      yes → push `job` frame → desktop runs it with the existing browser code
            → `run-event` frames back → cloud writes run_events, run status
      no  → run parks: waiting / connector_offline → resumes on `hello`
```

---

## 3. What moves, stays, goes

**Moves to the desktop app** (about 5.5k lines, mostly unchanged)
- `src/browser/{manager,fleet,page,live-stream,session-store}.ts`, `src/providers/browser/*`, the `OPS` table in `src/browser-ops.ts`, `apps/browser-worker` startup logic.
- Sign-in: all three modes (`live`, `desktop`, `local`) collapse into one: sign in in your own Chrome.

**Stays in the cloud**
- Everything in `src/` that is not browser: auth, workspaces, sign-up, router, intents, assistant, runs, policy, approvals, audit, notifications, alerts, ingest, `src/ingest/email.ts`, scheduler for cloud tasks, the queue and its handlers for `dispatchDeliver`, `taskStart`, `runResume`.
- `src/browser/live.ts`: the web live view. Its remote path (`remoteSnapshots`, `acceptRemoteSnapshot`) already accepts org-tagged snapshots from another process; the gateway becomes that other process.
- New: gateway, dispatcher, devices, per-workspace inbound email.

**Thinner**
- The web app: same files. When no desktop is connected it replaces the browser panel with "Your computer is offline, last seen …" and keeps everything else.

**Retired after one release**
- Railway `browser` service, `ROLE=browser`, the fleet, Xvfb, x11vnc, noVNC, `/vnc`, `docker/seccomp_profile.json`, sandbox fallback.
- `public/connect.mjs` and the pairing helper flow (the desktop app is the helper).
- `src/persist.ts` session mirroring and Postgres-stored session blobs.
- Desktop sign-in mode (`startDesktopSignIn`, `desktop-tmp` sweeping).

---

## 4. Stages

Each stage leaves the current deployment working. Estimates assume one developer working with Claude Code; the signing certificate lead time is the long pole and starts in week 1.

### Stage 0: the host seam (about 1 week)

Goal: the browser code no longer imports the database directly. No behaviour change.

- Define `ConnectorHost` in `packages/core`:
  - `track(runId)`: `start/done/fail/failRunning` (today `RunTracker` from `src/runs.ts`)
  - `setPlatformState(platformId, patch)`
  - `addCapture / pruneCaptures`
  - `saveScreenshot(platformId, png) → path|url`
  - `loadSessionState / saveSessionState` (today `src/browser/session-store.ts`)
  - `cookies(domain)` for `detectLoginState`
  - `emit(event)` for bus events the UI listens to (`browser`, `pairing`, `log`)
- `LocalHost` implements it with today's `src/db.ts` calls. Wire it through `collectTasks`, `sendThroughBrowser`, `checkSignIn`, `runConfiguredAction`, `FleetManager`, `BrowserManager`.
- Verify: `npm test` and `npm run test:e2e` unchanged (139 unit, 26 e2e today). Nothing else.

### Stage 1: the gateway, cloud side (about 2 weeks)

Goal: the cloud can talk to a desktop it has never met, safely, and run one job through it.

- **Devices.** Migration (sqlite 15 / pg 109): `devices(id, org_id, user_id, name, token_hash, platform_os, app_version, last_seen_at, revoked_at)`. Pairing reuses `src/pairing.ts`: the app shows a code, the user types it in the web app (or signs in inside the app window and the app claims the device directly, since the window is the web app). Device token: long-lived, hashed, revocable from Settings › Devices, audited.
- **Socket.** `/gw` upgrade in `src/server.ts` next to `/live`. Auth by device token in the first frame, then the socket is bound to `(orgId, deviceId)` for its life. Origin check not applicable (not a browser); rate-limit pairing like login.
- **Frames** (JSON, binary for screencast):

  | Direction | Frame | Purpose |
  |---|---|---|
  | desktop → cloud | `hello {app, os, chrome, providers[]}` | announce; cloud answers with platform configs and pending jobs |
  | cloud → desktop | `job {jobId, op, payload, leaseMs}` | one browser op or delivery |
  | desktop → cloud | `ack {jobId}` / `result {jobId, ok, value|error}` | lease and answer |
  | desktop → cloud | `run-event {runId, key, status, detail}` | the host seam's `track` |
  | desktop → cloud | `state {snapshot}` | `BrowserSnapshot` (epoch + seq already exist) |
  | desktop → cloud | `platform {id, patch}` / `capture {…}` / `screenshot {…}` | host seam |
  | desktop → cloud | `frame` (binary) | screencast for web viewers |
  | cloud → desktop | `live {platform, level|null}` | a web viewer wants/stops frames |
  | both | `ping/pong` | 30 s, like `/live` |

- **Dispatcher.** A cloud-side consumer for browser-bound jobs (`JOB.browserOp`, chat deliveries whose provider `runs_on = desktop`, sync). It checks the org's online device, pushes `job`, holds the pg-boss job until `result`. No device → the run parks `waiting / connector_offline` and the job is released; `hello` from that org re-dispatches. Reuse the existing per-provider claim (`provider_claims`) so two devices in one workspace never drive the same account at once.
- **Live view.** Gateway feeds `state` into `acceptRemoteSnapshot(org, snap)` and `frame` into the existing per-org frame path in `src/browser/live.ts`. Web viewers work unchanged.
- **Cloud browser off by default** for workspaces that have a device; `ROLE=browser` still works for those that do not.
- Verify: `test/e2e/gateway.test.ts` with a fake connector (same style as `split.test.ts`): pair, hello, one chat job round-trip, run events land in `run_events`, offline parks and resumes, a device token from org A cannot receive org B's job, revoked token is refused.

### Stage 2: the desktop shell (about 2 to 3 weeks)

Goal: a real app on Windows and macOS that signs in to ChatGPT and runs a chat job that the web app can watch.

- `apps/desktop/` (Electron). Main process: `packages/connector` = gateway client + `GatewayHost` (the second `ConnectorHost`) + the moved browser code. Renderer: `BrowserWindow` loading `PUBLIC_URL`, preload exposes `window.desktop = { status, pair, openLogs, quit }`.
- Chrome: `resolveExecutable()` → dedicated profile under the app's data dir → launched non-headless with a real window (the same flags the fleet uses today: no `--enable-automation`, `--disable-blink-features=AutomationControlled`). Minimised or on a second desktop while working; the app's own screencast shows it in the window.
- Sessions: `safeStorage.encryptString` per provider, replacing `session-store.ts` on the desktop.
- Tray icon, start at login, single instance, "Pause connector".
- Sign-in flow: provider card → "Sign in" → Chrome window opens on the provider → app watches for the session cookie (the logic from `connect.mjs`) → status `logged_in` → cloud told via `platform` frame. Cloudflare sees a real Chrome at a home IP: the reason for the whole plan.
- Verify: manual on Windows 11 and macOS: install, pair, sign in to ChatGPT and Grok, send a chat from the web app on a phone and watch it run in the desktop app; close the app mid-run and see the run park.

### Stage 3: runs-on routing and the offline experience (about 1 to 2 weeks)

- Migration: `connections.runs_on` (`desktop|cloud`, default `desktop` when the workspace has a device), `runs.waiting_reason`.
- Router: a provider that `runs_on = desktop` with no device online is still selectable, but the answer says "queued until your computer is back" instead of pretending.
- Task view: badge per task: **runs at ChatGPT** (continues offline), **runs on your computer** (needs it on), **custom agent** (reports in). Derived from provider + task kind; `discovered` tasks are vendor-side by definition.
- Approvals: deciding one whose action runs on an offline desktop shows "Approved. Will run when your computer is back." (`runResume` parks the same way).
- Overview and notifications: "Your computer has been offline since 14:02. 2 runs are waiting."
- Verify: e2e with the fake connector going offline mid-run and returning; unit tests for the badge derivation.

### Stage 4: push channels for offline results (about 1 week)

- Per-workspace inbound address: `w-<token>@in.<domain>`, delivered by an inbound-mail provider webhook to `POST /api/inbound/email` (signed). The existing parser in `src/ingest/email.ts` (`mapRunStatus`, match to `listTasks`) handles it, scoped with `withOrg`. Settings shows the address with "Forward your ChatGPT and Grok task emails here".
- Keep the IMAP poller for self-hosted installs.
- Claude routines: the fire endpoint stays as is.
- Verify: unit tests with real ChatGPT task and Grok automation notification emails (redacted samples).

### Stage 5: packaging, signing, updates (about 2 weeks, plus certificate lead time)

- `electron-builder`: NSIS installer (Windows), DMG (macOS), AppImage/deb (Linux, best effort).
- Signing: Windows OV/EV certificate and Apple Developer account + notarization. Order these in week 1; they take days to weeks.
- Auto-update: `electron-updater` against GitHub Releases or a bucket. Connector version reported in `hello`; the cloud can refuse versions below a minimum.
- Web app: "Install the desktop app (recommended)" on Overview and in onboarding, with the reasons: your sign-ins stay on your computer, no bot checks, faster.
- Verify: clean-machine installs on both OSes, update from N to N+1, uninstall leaves no profile behind.

### Stage 6: retire the cloud browser (about 1 week, one release after Stage 5)

- Default `BROWSER_FLEET` and `ROLE=browser` off; remove the Railway browser service from `docs/railway.md` and `example.browser.env`.
- Dockerfile: drop Chrome, Xvfb, x11vnc, noVNC from the api image. The image shrinks by roughly 1 GB and the api service needs far less memory.
- Delete the retired code listed in section 3 and its tests (`fleet.test.ts`, `pairing.test.ts` parts, VNC paths).

Total: roughly 10 to 12 weeks to a signed v1 with the cloud browser gone.

---

## 5. Security checklist

- Device token: 32 random bytes, stored hashed, one per install, revocable, shown once. Never the user's password or session cookie.
- Socket bound to one `(org, device)` after auth. Every frame is validated against that org; a job for another org is a bug and is logged as `gateway.cross_org` with the socket closed.
- Preload bridge exposes a fixed, small API; `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the renderer. The renderer is the hosted web app and must not gain Node access.
- The connector only navigates to provider domains from the platform configs it received in `hello`. No open browsing on behalf of the cloud.
- Provider sessions never leave the machine. The `session.import` op is removed from the gateway op set.
- Screencast frames go only to web viewers of the same org, as `/live` already enforces.
- Audit: device paired, device revoked, connector online/offline, every job dispatched and its result, as today's runs and audit rows.

---

## 6. Risks and what to do about them

| Risk | Mitigation |
|---|---|
| Vendor ToS on automated access | Prefer official APIs per capability (Claude fire endpoint today); keep the honest capability flags; document the risk to users. The desktop app reduces detection, not the terms. |
| The host seam refactor sprawls | Stage 0 is time-boxed and behaviour-free; if it slips, ship the gateway with a narrower op set (chat, sync, sign-in) first. |
| Users with no always-on computer expect 24/7 browser tasks | Stage 3 badges and the "waiting" state make the limit visible before it hurts. Vendor-side schedules (ChatGPT tasks, Grok automations) are the answer for overnight work; the sync already discovers them. |
| Code-signing delays | Order certificates in week 1. Unsigned builds for internal testing only. |
| Two devices in one workspace | `provider_claims` already serialises a provider per workspace; the second device sees "in use on Laptop". |
| Electron size and memory | Chrome is the user's own; Electron adds about 150 MB on disk and one process. Acceptable for a tray app. |
| Corporate laptops, antivirus, VPNs | Ship a "Diagnose" button in the app: Chrome found, gateway reachable, provider reachable. Log locally with an export. |

---

## 7. What done looks like

See "Success story" below. Acceptance is that story, step by step, on a clean Windows and macOS machine, with the cloud browser service deleted from Railway.

---

## Success story

**Monday, 09:10.** Farhan signs up at the web app on his phone during the commute, confirms his email, and sees one line on the empty dashboard: *Install the desktop app to connect your agents. Your sign-ins stay on your computer.*

**09:40, at his desk.** He installs the app. It opens, shows the same dashboard he saw on the phone, and asks him to connect an AI. He clicks ChatGPT. His own Chrome opens on chatgpt.com, already at the sign-in page. No "verify you are human." He signs in the way he always does; the app notices and the card turns green: *ChatGPT, signed in, runs on this computer.* Grok and Claude take two minutes each. His team's own scanner bot is registered with an ingest token, and it turns green on its own when it reports in.

**10:05.** He types: *Analyze the payments repo and prepare a security report.* The control plane answers in one line: it's sending this to ChatGPT's agent, because that agent can read the GitHub repo and works in ChatGPT's cloud, so it will continue if he steps away. The run appears on the right with the live browser: the app drives Chrome, pastes the brief, the agent starts. The task card says **runs at ChatGPT, continues when your computer is off.**

**10:20.** He closes the laptop and leaves for a client visit. The desktop app disconnects; the cloud marks the device offline and keeps the run open.

**11:45, in a taxi.** A notification: *ChatGPT finished "Security report for payments": done.* The email ChatGPT sent when the task completed went to his workspace's inbound address, so the cloud knew before he did. He opens the web app on his phone. The run shows *success* with the summary from the notification and the sentence *Full result and screenshot will arrive when your computer reconnects.* Beneath it, a pending approval: the scanner bot wants to open a ticket for a critical finding. He approves it. The scanner bot runs in its own environment, so the ticket is created immediately.

**13:30, back at the desk.** He opens the laptop. The app reconnects within seconds: *Back online. Syncing.* It reads ChatGPT's task page, pulls the full report into the run, and takes the screenshot. The dashboard shows what happened while he was away: one completed run, one approval he already decided, the scanner bot's ticket, and one Grok automation that failed overnight with a sign-out, which the app flags with a one-click **Sign in again** that opens his own Chrome.

**Friday.** On the Overview, a small badge on the Grok card reads *runs on this computer*; the Grok automation he created on Monday reads *runs at Grok, continues when your computer is off*. He has never seen a bot check, never typed a cookie, and never wondered where his sign-ins are: they're on his laptop, and the cloud only ever knew that they worked.

**For the founder.** The Railway browser service is gone. The api image is a third of its old size. Cost per workspace is a few database rows and a WebSocket. Support tickets are about agents, not Cloudflare.
