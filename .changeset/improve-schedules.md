---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Schedules can start improvement passes. `POST /v1/schedules` takes `improve: { agentId, scope }` instead of `flowId` or `agentId`, and `kindgi schedules create --improve=<agent-id>` with `--tenant`, or `--project` and `--segment`.
- **When a pass starts:** each fire counts the trusted "no" judgments (recorded under a restricted judge class) on the agent's runs in the scope since its last pass. With enough of them, across enough runs and judges, it starts a pass on a fresh test set of those runs. Otherwise the fire is `skipped`, and its `detail` says which count was short.
- **Input:** `config.input` takes the pass options `improve` takes, plus `threshold` (default 5 judgments, 3 runs, 2 judges) and `monthlyCapUsd` (default 20). It's kept with the defaults applied.
- **Permissions:** registering needs `publish` on the agent.
- **Scope:** the tenant, or the schedule's project or a segment of it.
- **Interval:** at most once an hour.
- **Fires:** a fire that started a pass names it (`passId`). A pass a schedule started names the schedule and fire (`trigger`).
- **Webhooks:** endpoints can subscribe to `improvement-pass.finished`, sent when any pass ends, with the pass. `projectId` narrows it; `flowIds` and `includeDryRuns` are about runs only. The Python `parse_event` reads it.
