# Reporting from a Claude Code routine

Claude Code routines run in the cloud and can call any HTTP endpoint, so they can
report straight into the control plane as their last step. Add the block below to
the end of the routine's prompt, and give the routine two environment variables:
`ACP_URL` (your deployment) and `ACP_INGEST_TOKEN`.

```
When you are completely finished, report the outcome to my control plane with one
curl call. Use status "success" if everything worked, "failed" if you hit an
error you could not recover from, or "needs_attention" if a human has to decide
something. Keep the summary under 300 characters and include a link to the PR,
commit or document you produced when there is one.

curl -sS -X POST "$ACP_URL/api/ingest" \
  -H "Authorization: Bearer $ACP_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": {
      "platform": "claude",
      "key": "nightly-dependency-audit",
      "name": "Nightly dependency audit",
      "schedule": "daily 02:00 UTC",
      "native_url": "https://claude.ai/code"
    },
    "run": {
      "status": "<success|failed|needs_attention>",
      "summary": "<one or two sentences>",
      "output_url": "<link to the PR or artifact, or omit>"
    }
  }'
```

The same pattern works for any agent that can run a shell command or make an
HTTP request: Grok Bot routines, ChatGPT agents with a code tool, cron jobs,
GitHub Actions. The `key` is what ties runs to the same agent, so keep it stable.

For agents that cannot call HTTP, such as ChatGPT scheduled tasks, turn on the
email notification for the task and configure IMAP in the control plane. Every
notification email becomes an event, and if the subject or body contains the
agent's name, it is also recorded as a run.
