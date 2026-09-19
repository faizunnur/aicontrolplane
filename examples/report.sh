#!/usr/bin/env bash
# Report a run to the AI Control Plane from any shell (cron job, CI step, agent post-step).
#
#   export ACP_URL=https://your-app.up.railway.app ACP_INGEST_TOKEN=...
#   ./report.sh <platform> <agent-key> <status> "<summary>" [output_url] [agent name]
#
#   ./report.sh custom nightly-backup success "Backed up 12 GB" https://s3/.../log.txt "Nightly backup"
#   ./report.sh grok competitor-watch failed "Login page changed, selector not found"
set -euo pipefail

: "${ACP_URL:?set ACP_URL to your control plane base URL}"
: "${ACP_INGEST_TOKEN:?set ACP_INGEST_TOKEN}"

platform="${1:?platform}"; key="${2:?agent key}"; status="${3:?status}"; summary="${4:-}"; output_url="${5:-}"; name="${6:-$key}"

payload=$(node -e '
const [platform,key,status,summary,output_url,name]=process.argv.slice(1);
const body={agent:{platform,key,name},run:{status,summary,finished_at:new Date().toISOString()}};
if(output_url) body.run.output_url=output_url;
process.stdout.write(JSON.stringify(body));
' "$platform" "$key" "$status" "$summary" "$output_url" "$name" 2>/dev/null || printf '{"agent":{"platform":"%s","key":"%s","name":"%s"},"run":{"status":"%s","summary":"%s","output_url":"%s"}}' "$platform" "$key" "$name" "$status" "$summary" "$output_url")

curl -sS -X POST "${ACP_URL%/}/api/ingest" \
  -H "Authorization: Bearer ${ACP_INGEST_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$payload"
echo
