# Running on your own computer

Three ways, from simplest to closest-to-production. All of them serve the dashboard at
**http://localhost:8080**.

| | What you need | Browser the agent drives | Best for |
|---|---|---|---|
| A. `npm run dev` | Node 22+ | a real Chromium window on your desktop | using it daily, developing |
| B. `docker compose up` | Docker | Chrome inside the container, seen at `/vnc/` | trying the exact image Railway runs |
| C. split services | Docker (for Postgres + Redis) or Docker only | inside the browser container | testing the scaled-out shape |

---

## A. Straight from the source (recommended)

```sh
git clone <this repo> && cd aicontrolplane
npm install
npx playwright install chromium     # once: the browser the agent drives
npm run dev
```

Open http://localhost:8080, create your account (email + password), and sign in to each AI
from the menu next to it on the left. The agent's browser opens as a **real window on your
desktop** — you can watch it work, and signing in is just signing in, since the sites see an
ordinary browser on your home connection.

- Everything is kept in `./data` (a SQLite file, the browser profile, the encryption key).
  Delete the folder to start over.
- `npm run dev` restarts the server when you edit code.
- Already have Google Chrome? Set `BROWSER_CHANNEL=chrome` and skip the Playwright download.
- No window wanted? Set `HEADLESS=true` (then sign in through the live view in the app).
- Only want the dashboard and API, no browser at all? `BROWSER_ENABLED=false`.

### Settings

The app reads environment variables. Two ways to give it some:

```sh
cp .env.example .env      # edit what you need (all optional locally)
npm run dev:env           # same as npm run dev, reading .env
```

or set them in the shell for one run:

```sh
# macOS / Linux
HEADLESS=true LOG_LEVEL=debug npm run dev
```
```powershell
# Windows PowerShell
$env:HEADLESS="true"; $env:LOG_LEVEL="debug"; npm run dev
```

Useful locally: `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token`) to let Claude answer in
the command panel; `PORT` if 8080 is taken.

### Using Postgres instead of SQLite (optional)

```sh
docker run -d --name acp-pg -e POSTGRES_PASSWORD=acp -e POSTGRES_DB=acp -p 5432:5432 postgres:17-alpine
```

then add `DATABASE_URL=postgres://postgres:acp@localhost:5432/acp` to `.env` and use
`npm run dev:env`. Tables are created on first start. To carry existing local data across:
`DATABASE_URL=... npx tsx scripts/migrate-sqlite-to-pg.ts ./data/acp.sqlite` with the server
stopped.

### Tests

```sh
npm run typecheck && npm run lint
npm test                 # unit tests, a few seconds, no browser
npm run test:e2e         # starts real servers with headless Chromium against a mock AI site
```

The Postgres and split-mode tests run when these are set (throwaway containers):

```sh
docker run -d --name acp-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
docker run -d --name acp-test-redis -p 56379:6379 redis:7-alpine
docker exec acp-test-pg psql -U postgres -c "create database acp_test"
TEST_PG_URL=postgres://postgres:test@localhost:55432/acp_test npm test
TEST_PG_URL=postgres://postgres:test@localhost:55432/acp_test npm run test:e2e
```

---

## B. The Docker image (what Railway runs)

```sh
docker compose up --build
```

- Dashboard: http://localhost:8080. The password is the `ACP_ADMIN_TOKEN` value —
  `change-me-admin` unless you set your own in `.env` (do).
- The agent's Chrome runs on a virtual display in the container; watch it in the app's live
  view, or the whole screen at http://localhost:8080/vnc/.
- Data lives on the `acp-data` Docker volume and survives `docker compose down`
  (`down -v` wipes it).

---

## C. Split services, like a scaled deployment

The api, worker and browser as separate processes over Postgres and Redis.

**All in Docker:**

```sh
cp .env.example .env
# in .env set: ACP_MASTER_KEY=<openssl rand -hex 32>   (and POSTGRES_PASSWORD if you like)
docker compose --profile split up --build
```

**Or from source**, with only Postgres and Redis in Docker — three terminals, same
`ACP_MASTER_KEY` in each (a split process refuses to start without one):

```sh
docker run -d --name acp-pg -e POSTGRES_PASSWORD=acp -e POSTGRES_DB=acp -p 5432:5432 postgres:17-alpine
docker run -d --name acp-redis -p 6379:6379 redis:7-alpine

# every terminal:
export DATABASE_URL=postgres://postgres:acp@localhost:5432/acp
export REDIS_URL=redis://localhost:6379
export ACP_MASTER_KEY=<the same 64 hex characters>

ROLE=api     PORT=8080 npm run dev     # terminal 1: dashboard + API
ROLE=worker  PORT=8081 npm run dev     # terminal 2: jobs, schedules, sweeps
ROLE=browser PORT=8082 npm run dev     # terminal 3: the browser (a window opens)
```

(PowerShell: `$env:NAME="value"` instead of `export`, and set `ROLE`/`PORT` the same way before
each `npm run dev`.)

Use http://localhost:8080 as usual. Each process answers `/healthz` and `/readyz` on its own
port; `/metrics` on 8081 and 8082 shows queue depth and job counts.

For running it permanently on a server of your own, see [self-hosted.md](self-hosted.md).
