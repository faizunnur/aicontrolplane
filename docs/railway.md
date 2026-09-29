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

1. **New project → Deploy from GitHub repo**, pick this repository. Railway finds the root
   `Dockerfile` and builds it (Chrome, a virtual display and noVNC are inside the image). No
   config file is involved: every setting below is made in the dashboard.
2. **Settings → Deploy → Healthcheck Path**: `/healthz`. (While you are there, set the restart
   policy to "On failure".)
3. **Add Postgres**: in the project, **+ New → Database → PostgreSQL**.
4. In the app service's **Variables**, add:

   | Variable | Value | Why |
   |---|---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_PRIVATE_URL}}`: the value under Postgres → Connect → **Private Network** | Postgres becomes the database: chats, runs, approvals, settings, sealed sign-ins. |
   | `ACP_MASTER_KEY` | output of `openssl rand -hex 32` | Encrypts stored secrets (provider cookies, webhook and routine tokens). **Required on Railway without a volume** — without it the key is regenerated on every deploy and every saved sign-in becomes unreadable. Keep a copy somewhere safe. |

5. **Settings → Resources**: give it at least **2 GB** of memory (it runs Chrome).
6. **Settings → Networking → Generate Domain**. The app picks the address up by itself
   (`RAILWAY_PUBLIC_DOMAIN`); set `PUBLIC_URL` only if you use a custom domain.
7. Deploy. Open the domain, create your account (email + password), then sign in to each AI
   from the menu next to it on the left. For Grok, choose **Connect from this computer**.

No volume is needed: everything that matters lives in Postgres. The browser profile on disk
is only a cache — sign-ins are restored from the database into a fresh profile after each
deploy. (A volume at `/data` still works and keeps the profile warm; if you attach one, Railway
mounts it and the app uses it automatically.)

**Alternative without Postgres:** skip step 3 and `DATABASE_URL`, attach a volume
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

- Railway's health check calls `/healthz` (the path you set in step 2).
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
2. Copy the Postgres **public** address: Postgres → **Connect → Public Network** (the
   `DATABASE_PUBLIC_URL` value). This step runs on your computer, which cannot reach Railway's
   private network.
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
   `ACP_PG_SSL=no-verify` makes it work but disables certificate checks for this one
   migration run — prefer fixing the certificate; the server warns loudly when it is set.
4. Add `ACP_MASTER_KEY` (see above) to the app service, then deploy the new version.
5. Sign in with your existing password (the email field can stay empty), then
   **Settings › Saved sign-ins › Restore** with the file from step 1.

Anything written between step 3 and the deploy stays in the old copy only, so do this at a
quiet moment.

**To keep the old behaviour exactly instead**, set `DB_DRIVER=sqlite`,
`PERSIST_DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}` and `ACP_MASTER_KEY` before deploying. You
can migrate later.

---

## 3. Split services

The shape that scales: a slim **api** (serves the dashboard and API, only enqueues work), a
**worker** (task starts, webhooks, approval resumes, email, sweeps) and a **browser** service
(everything that drives Chrome). They talk through Postgres (source of truth and job queue)
and Redis (events, live-view frames, shared rate limits). You need Postgres already — do the
migration in section 2 first if you are coming from SQLite.

### Services

Create each from the same GitHub repo (**+ New → GitHub Repo**) and name them exactly `api`,
`worker` and `browser` (the variables below refer to those names). Everything is set in the
dashboard; no config file is used. (Railway's "Config-as-code" file setting is deprecated, so
this guide does not rely on it.)

| Service | Which image (`RAILWAY_DOCKERFILE_PATH` variable) | Memory |
|---|---|---|
| `api` | `Dockerfile.api`: slim, no Chrome, non-root | 512 MB |
| `worker` | `Dockerfile.api` | 512 MB |
| `browser` | `Dockerfile`: Chrome + virtual display (the default, so the variable is optional) | 2 GB+ |

The image is chosen by the `RAILWAY_DOCKERFILE_PATH` variable in each service's block below.
Without it Railway builds the root `Dockerfile` (the Chrome image). That works for any role,
but it is a much bigger image for the api and worker to carry.

In **each** service, also set **Settings → Deploy → Healthcheck Path** to `/healthz`, and the
restart policy to "On failure".

Add **Redis** (**+ New → Database → Redis**) next to Postgres. Generate a domain for `api`
only; the others need none.

### Variables, service by service

Every variable is set on the service itself (**service → Variables → Raw Editor**, paste the
block). No project-level shared variables are used.

First generate one encryption key on your computer and keep it somewhere safe:

```sh
openssl rand -hex 32
```

Paste that **same** value as `ACP_MASTER_KEY` into all three services below. The api seals a
secret (for example an agent's webhook token) and the worker opens it, so the values must
match exactly. A split service refuses to start without one.

**Always use the private network address for the services.** Open Postgres (or Redis) →
**Connect → Private Network** and copy the reference it shows. Depending on when the database
was created, Railway names it `DATABASE_PRIVATE_URL` or `DATABASE_URL` (and `REDIS_PRIVATE_URL`
or `REDIS_URL`); the Connect dialog shows the right one for yours. The private address stays
inside Railway, is faster, and costs nothing in network egress. It needs no TLS setting. The
public address is only for connecting from your own computer (the migration in section 2).

`${{Postgres.DATABASE_PRIVATE_URL}}`, `${{Redis.REDIS_URL}}` and `${{api.RAILWAY_PUBLIC_DOMAIN}}` are
Railway *reference* variables: each service reads the value from the Postgres, Redis or api
service, and it stays correct if that service's address changes. They are set per service
like any other variable. If you prefer, paste the literal values instead.

#### `api` service

```env
ROLE=api
RAILWAY_DOCKERFILE_PATH=Dockerfile.api
DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}?family=0
ACP_MASTER_KEY=<the 64-character key>
VNC_TARGET=http://browser.railway.internal:6080
TRUST_PROXY=1
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15
```

Optional, only on the api:

| Variable | Why here |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | The command chat and AI routing run on the api. |
| `ACP_ADMIN_TOKEN`, `ACP_INGEST_TOKEN` | Sign-in and agent authentication happen on the api. |

`PUBLIC_URL` is not needed here: the api reads its own Railway domain. Set it only for a custom
domain, and then use the same value on the other two services.

#### `worker` service

```env
ROLE=worker
RAILWAY_DOCKERFILE_PATH=Dockerfile.api
DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}?family=0
ACP_MASTER_KEY=<the same 64-character key>
PUBLIC_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
TRUST_PROXY=1
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
```

`PUBLIC_URL` is required: the worker puts the api's address into the report link it sends
your agents when it starts their tasks.

Optional on the worker: `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` (and the other `IMAP_*` /
`EMAIL_*` settings) for reading task emails, and `ACP_EGRESS_POLICY` / `ACP_EGRESS_ALLOWLIST`
if your agents' webhooks live on a private network.

#### `browser` service

```env
ROLE=browser
RAILWAY_DOCKERFILE_PATH=Dockerfile
DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}?family=0
ACP_MASTER_KEY=<the same 64-character key>
PUBLIC_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
VNC_BIND=::
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
```

Optional on the browser: `SYNC_INTERVAL_MIN` (and the other `SYNC_*` settings), which control
how often each AI's tasks page is checked, and `DESKTOP_SIGNIN_TIMEOUT_MIN`. Optionally attach
a volume at `/data` so the Chrome profile stays warm across deploys (not required).

#### Settings that go on more than one service

| Variable | api | worker | browser | Why |
|---|:-:|:-:|:-:|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_WEBHOOK_URL`, `ALERT_COOLDOWN_MIN` | ✓ | ✓ | ✓ | Any of the three can raise an alert: the api when an agent reports a failure (and for the "send a test alert" button), the worker for email problems, the browser when an AI signs you out. |
| `IMAP_*`, `EMAIL_*` | ✓ | ✓ | | The worker polls on a schedule; the "check email now" button runs on the api. |
| `LOG_LEVEL`, `LOG_FORMAT` | ✓ | ✓ | ✓ | Each service prints its own log. |

#### Notes

- `?family=0` lets the Redis client resolve Railway's private network addresses (IPv4 or
  IPv6); without it, connections to `*.railway.internal` can fail.
- `TRUST_PROXY=1` tells the app it sits one hop behind Railway's proxy, so rate limits and
  audit rows use the real client address from `X-Forwarded-For`. Without it (the default)
  the socket address is used — correct for direct exposure, wrong behind a proxy.
- `VNC_TARGET` (api) and `VNC_BIND` (browser) carry the "cloud desktop" sign-in screen
  (`/vnc`) from the browser service through the api. The live view of the agent's tab does not
  need them; it travels over Redis. This pair has not yet been exercised on Railway. If the
  desktop sign-in screen does not load, check the browser service's log for the noVNC bind
  line first.
- `browser.railway.internal` assumes the browser service is named `browser`. If you named it
  differently, use `<name>.railway.internal`, and change `api` in
  `${{api.RAILWAY_PUBLIC_DOMAIN}}` to the api service's name.

### Scaling

- `api` and `worker`: raise **replicas** freely; they hold no state.
- `browser`: with `BROWSER_FLEET=ephemeral`, each replica opens isolated per-workspace
  contexts and a per-(workspace, provider) claim keeps two replicas from driving the same
  signed-in account — more than one replica is safe, though multi-replica has not yet been
  load-proven on Railway. In legacy mode (one persistent profile) keep it at **1**.
- Watch `/metrics` on the api (admin sign-in required) for queue depth (`acp_queue_jobs`),
  active runs and request latency before scaling anything.

### Health

Each service answers `/healthz` (process alive) and `/readyz` (database reachable) on its
`PORT`; point each service's Healthcheck Path at `/healthz` as described above.
