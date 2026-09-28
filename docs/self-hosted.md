# Self-hosting the AI Control Plane

Everything runs on your own machine or server, packaged as Docker images. (Just trying it on
your laptop? [local.md](local.md) is quicker. Hosting on Railway? [railway.md](railway.md).) Your data, your
provider sign-ins (cookies), your encryption key — none of it leaves your infrastructure,
and nothing here depends on Railway, Kubernetes, or any hosted control plane.

## The two shapes

**One container** — simplest, fine for one person:

```sh
docker compose up --build -d
```

One process (`ROLE=all`) does everything; state lives on the `acp-data` volume (SQLite), or
in Postgres if you set `DATABASE_URL`.

**Split services** — the shape that scales, and the recommended production setup:

```sh
cp .env.example .env
# set: POSTGRES_PASSWORD, ACP_MASTER_KEY (openssl rand -hex 32), PUBLIC_URL
docker compose -f docker-compose.selfhosted.yml up --build -d
```

| Service | Image | What it does |
|---|---|---|
| `api` | slim Node (no Chrome), non-root | HTTP + dashboard + event stream; only enqueues work |
| `worker` | slim Node | task starts, webhook dispatches, resumes, email, sweeps |
| `browser` | Playwright + Chrome + Xvfb | everything that drives a browser: chats, syncs, sign-ins, the live view |
| `db` | postgres:17 | the source of truth and the job queue |
| `redis` | redis:7 | events between services, shared rate limits, live-view frames |

Scale the stateless services when load calls for it:

```sh
docker compose -f docker-compose.selfhosted.yml up -d --scale worker=3
```

## Environment

The full reference is `.env.example`. The ones that matter first:

- `ACP_MASTER_KEY` — encrypts every stored secret (provider cookies, webhook and routine
  tokens). Generate with `openssl rand -hex 32` and keep it in your secret store; the same
  value must reach every service. The split services refuse to start without it; the single
  container generates a key file in its data volume instead.
- `PUBLIC_URL` — the address people (and the pairing helper) reach this deployment on. It is
  never guessed from request headers.
- `ACP_ADMIN_TOKEN` — optional; without it the first visit creates the owner account
  (email + password, argon2id-hashed).
- `ACP_EGRESS_POLICY` — outbound calls to agent webhooks are `strict` in production (private
  addresses refused, connections pinned to checked IPs). Webhooking your own LAN? Add hosts
  to `ACP_EGRESS_ALLOWLIST=host1,host2` or set `permissive`.

## Operations

- **Migrations** run automatically at startup; they are additive and safe to re-run.
- **Health**: every service serves `/healthz` (liveness) and `/readyz` (database reachable).
- **Metrics**: Prometheus text at `/metrics` — admin-gated on the api, open on the workers'
  internal ports (request durations, queue depth, active runs, settled runs, failures,
  connected clients).
- **Backups**: `pg_dump` the `acp` database. Secrets inside it are sealed; a leaked dump
  without `ACP_MASTER_KEY` exposes no credentials.
- **Moving from SQLite** (an older single-container install):
  `DATABASE_URL=... npx tsx scripts/migrate-sqlite-to-pg.ts /data/acp.sqlite` with the
  server stopped, then start with `DATABASE_URL` set.
- **Upgrades**: `docker compose ... up --build -d` — rolling by service; runs survive
  restarts (approvals park durably; interrupted work is reaped and surfaced, never lost
  silently).
