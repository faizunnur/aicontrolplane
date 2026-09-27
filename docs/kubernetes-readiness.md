# Kubernetes readiness

Kubernetes is a future deployment target, not a requirement: nothing in the application
knows about it, and the same Docker images that run on Railway and in Docker Compose run
unchanged on a cluster. This page maps what exists to what a cluster needs.

## What the images already provide

- **12-factor configuration**: everything via environment variables; no config files to mount.
- **Statelessness**: `api` and `worker` hold no state a pod loss would lose — Postgres is the
  source of truth and the job queue, Redis carries only re-derivable events. The `browser`
  pod's profile directory is a warm cache; signed-in sessions are sealed in Postgres and
  restored on a fresh pod.
- **Probes**: `/healthz` (liveness — process only, never dependencies) and `/readyz`
  (readiness — database reachable) on every service.
- **Graceful shutdown**: SIGTERM stops claiming jobs, finishes or releases current work,
  closes the browser cleanly, then exits; abandoned work is reaped by silence and retried
  or surfaced, so even SIGKILL loses nothing durable.
- **Metrics**: Prometheus text at `/metrics` on every service — request durations, queue
  depth per queue, active runs by state, settled runs, job failures, connected clients.
- **No leader assumptions**: recurring work fires from the shared queue cron (one firing per
  interval, whoever claims it); rate limits count in Redis; approvals park in Postgres and
  resume on any instance.

## The mapping, when the time comes

| Concern | Shape |
|---|---|
| `api` | Deployment, 2+ replicas; HPA on `acp_http_request_duration_seconds` rate + CPU; PDB minAvailable 1 |
| `worker` | Deployment; scale on `acp_queue_jobs` (KEDA's Postgres or Prometheus scaler) |
| `browser` | Deployment on a dedicated node pool (2 CPU / 4–6 GB per pod, `shm` emptyDir); scale on `acp_queue_jobs{queue=~"browser.*"}`; generous terminationGracePeriod |
| Postgres / Redis | managed services, or operators; the app needs nothing special |
| Ingress | TLS terminate → `api`; WebSocket upgrade for `/live` and `/vnc` |
| Secrets | `ACP_MASTER_KEY`, `DATABASE_URL`, `REDIS_URL` via Secret + env |
| NetworkPolicy | default-deny; only `browser`/`worker` need internet egress; the SSRF egress guard in the app complements, not replaces, this |

## What is deliberately NOT here

No manifests, no Helm chart, no K8s API calls in code — by design, so the self-hosted
Compose deployment and Railway stay first-class. Write manifests against the table above
when a cluster is actually the next step.
