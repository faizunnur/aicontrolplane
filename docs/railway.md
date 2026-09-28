# Deploying on Railway

The same Docker images run on Railway, in Docker Compose and (later) anywhere else; nothing in
the application depends on Railway. Railway is simply the quickest place to host it.

There are two shapes. Start with the first; move to the second when one container is no
longer enough.

| | One service (`ROLE=all`) | Split services |
|---|---|---|
| Services | 1 app + Postgres | api + worker + browser + Postgres + Redis |
| Good for | one person or a small team | more users, more concurrent work, zero-downtime api deploys |
| Memory | 2 GB+ | api 512 MB, worker 512 MB, browser 2 GB+ |
| Status | what has been running on Railway | tested end to end locally (3-process e2e); not yet run on Railway itself |

---

## 1. One service (recommended start)

### Create it

1. **New project → Deploy from GitHub repo**, pick this repository. Railway finds
   `railway.toml` and builds the root `Dockerfile` (Chrome, a virtual display and noVNC are
   inside the image).
2. **Add Postgres**: in the project, **+ New → Database → PostgreSQL**.
3. In the app service's **Variables**, add:

   | Variable | Value | Why |
   |---|---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Postgres becomes the database: chats, runs, approvals, settings, sealed sign-ins. |
   | `ACP_MASTER_KEY` | output of `openssl rand -hex 32` | Encrypts stored secrets (provider cookies, webhook and routine tokens). **Required on Railway without a volume** — without it the key is regenerated on every deploy and every saved sign-in becomes unreadable. Keep a copy somewhere safe. |

4. **Settings → Resources**: give it at least **2 GB** of memory (it runs Chrome).
5. **Settings → Networking → Generate Domain**. The app picks the address up by itself
   (`RAILWAY_PUBLIC_DOMAIN`); set `PUBLIC_URL` only if you use a custom domain.
6. Deploy. Open the domain, create your account (email + password), then sign in to each AI
   from the menu next to it on the left. For Grok, choose **Connect from this computer**.

No volume is needed: everything that matters lives in Postgres. The browser profile on disk
is only a cache — sign-ins are restored from the database into a fresh profile after each
deploy. (A volume at `/data` still works and keeps the profile warm; if you attach one, Railway
mounts it and the app uses it automatically.)

**Alternative without Postgres:** skip step 2 and `DATABASE_URL`, attach a volume
(**Settings → Volumes**, mount path `/data`). Everything is kept in a SQLite file on the
volume. Fine for one person; it cannot be split into several services later without the
migration below.

### Optional variables

| Variable | What it does |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | The command panel answers in Claude's words and routes messages to the right AI. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL` | Alerts when something fails or an AI signs you out. |
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` | Read task notification emails into the registry. |
| `ACP_ADMIN_TOKEN` | Pin the owner password on the server instead of creating it on first visit. |
| `SYNC_INTERVAL_MIN` | How often each provider's tasks page is checked (default 20). |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` — what Railway's log shows. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | Set to `30`. Railway's default gives a stopping container almost no time; the app needs a few seconds to stop taking jobs, close Chrome cleanly and save the sign-ins. |

The full list is in [`.env.example`](../.env.example). Migrations run on boot.

### Check it is healthy

- Railway's health check calls `/healthz` (configured in `railway.toml`).
- `https://<your-domain>/readyz` returns `200` once the database answers.
- **Monitoring › Logs** in the app shows the last 2000 log lines at every level, even ones
  Railway's log does not print.

---

## 2. Upgrading an existing Railway deployment

What to do depends on how your deployment kept its data before this version.

**You had a volume at `/data` and no `DATABASE_URL`** — nothing to do. It keeps using its
SQLite file. Adding `ACP_MASTER_KEY` is optional here (the generated key lives on the volume),
but recommended so the key is in your hands.

**You had `DATABASE_URL` set (the old "mirror" setup, no volume)** — read this before
deploying. `DATABASE_URL` used to mean "back the files up into Postgres"; it now means
"Postgres *is* the database". Deployed as-is, the new version would start on empty tables and
show the "create your account" screen to whoever opens the site first. Your old data is still
there (in the `acp_files` table) and is moved over like this:

1. In the app (still the old version), **Settings › Saved sign-ins › Download** — keep the file;
   it is your cookies, treat it like a password.
2. Copy the Postgres service's `DATABASE_PUBLIC_URL` (Postgres service → Variables).
3. On your computer, in a checkout of this repository at the new version (`npm install` once):

   ```sh
   # macOS / Linux
   DATABASE_URL="<DATABASE_PUBLIC_URL>" npx tsx scripts/migrate-sqlite-to-pg.ts --from-mirror
   ```
   ```powershell
   # Windows PowerShell
   $env:DATABASE_URL="<DATABASE_PUBLIC_URL>"; npx tsx scripts/migrate-sqlite-to-pg.ts --from-mirror
   ```

   It reads the mirrored SQLite file out of `acp_files`, creates the new tables, copies every
   row, turns your existing password into the owner account and carries your provider
   settings over. It is safe to run more than once. If the connection is refused over TLS,
   add `ACP_PG_SSL=no-verify`.
4. Add `ACP_MASTER_KEY` (see above) to the app service, then deploy the new version.
5. Sign in with your existing password (the email field can stay empty), then
   **Settings › Saved sign-ins › Restore** with the file from step 1.

Anything written between step 3 and the deploy stays in the old copy only, so do this at a
quiet moment.

**To keep the old behaviour exactly instead**, set `DB_DRIVER=sqlite`,
`PERSIST_DATABASE_URL=${{Postgres.DATABASE_URL}}` and `ACP_MASTER_KEY` before deploying. You
can migrate later.

---

## 3. Split services

The shape that scales: a slim **api** (serves the dashboard and API, only enqueues work), a
**worker** (task starts, webhooks, approval resumes, email, sweeps) and a **browser** service
(everything that drives Chrome). They talk through Postgres (source of truth and job queue)
and Redis (events, live-view frames, shared rate limits). You need Postgres already — do the
migration in section 2 first if you are coming from SQLite.

### Services

Create each from the same GitHub repo (**+ New → GitHub Repo**), then in each service's
**Settings → Config-as-code**, set the config file path:

| Service name | Config file | Image | Memory |
|---|---|---|---|
| `api` | `/railway/api.toml` | `Dockerfile.api` (slim, non-root) | 512 MB |
| `worker` | `/railway/worker.toml` | `Dockerfile.api` | 512 MB |
| `browser` | `/railway/browser.toml` | `Dockerfile` (Chrome + display) | 2 GB+ |

Add **Redis** (**+ New → Database → Redis**) next to Postgres. Generate a domain for `api`
only; the others need none.

### Shared variables

In **Project Settings → Shared Variables**, add `ACP_MASTER_KEY` (`openssl rand -hex 32`).
Every service must have the **same** value — the api seals a webhook token, the worker opens
it. A split service refuses to start without it.

### Per-service variables

| Variable | api | worker | browser |
|---|---|---|---|
| `ROLE` | `api` | `worker` | `browser` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | same | same |
| `REDIS_URL` | `${{Redis.REDIS_URL}}?family=0` | same | same |
| `ACP_MASTER_KEY` | `${{shared.ACP_MASTER_KEY}}` | same | same |
| `PUBLIC_URL` | (automatic) | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` | same as worker |
| `VNC_TARGET` | `http://browser.railway.internal:6080` | | |
| `VNC_BIND` | | | `::` |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `15` | `30` | `30` |

Notes:

- `?family=0` lets the Redis client resolve Railway's private network addresses (IPv4 or
  IPv6); without it, connections to `*.railway.internal` can fail.
- `VNC_TARGET` / `VNC_BIND` carry the "cloud desktop" sign-in screen (`/vnc`) from the
  browser service through the api. The live view of the agent's tab does not need them — it
  travels over Redis. This pair has not yet been exercised on Railway; if the desktop sign-in
  screen does not load, check the browser service's log for the noVNC bind line first.
- Optional variables (`TELEGRAM_*`, `IMAP_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `LOG_LEVEL`…) are
  simplest as shared variables referenced from all three services; each process uses only
  what applies to it.
- Optionally attach a volume at `/data` to `browser` so the Chrome profile stays warm across
  deploys. Not required.

### Scaling

- `api` and `worker`: raise **replicas** freely; they hold no state.
- `browser`: today one replica drives one Chrome with all sign-ins; keep it at **1**. More
  browser replicas need per-connection browser contexts, which is not built yet (see the
  capacity notes in the migration plan).
- Watch `/metrics` on the api (admin sign-in required) for queue depth (`acp_queue_jobs`),
  active runs and request latency before scaling anything.

### Health

Each service answers `/healthz` (process alive) and `/readyz` (database reachable) on its
`PORT`; the config files point Railway's health check at `/healthz`.
