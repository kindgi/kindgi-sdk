---
"@kindgi/agents": patch
"@kindgi/runtime": patch
"@kindgi/capabilities": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Replay turns: an agent turn can re-run a past run for an eval run without doing anything the past run didn't do.

- `@kindgi/agents`:
  - `InvokeAgentInput.replay` (`{ of, evalRunId }`) marks a turn as a replay. It is kept on the turn's run and in its run snapshot (new nullable `agent_run_snapshots.replay` column), so a resumed turn stays a replay.
  - The new optional `InvokeAgentBindings.replay` (`ReplayBinding`) decides each tool call:
    - `live`: the tool runs;
    - `recorded`: the past run's result is used;
    - `refused`: the model gets the given result.
  - Whatever the binding says, only a tool declared read-only (`mutating: false`, no writing effect, see `isReadOnlyTool`) with no approval to wait for runs. A replay with no binding refuses every call.
  - Each decision is journaled, and `AgentTurnResult.replay` lists them. A refused call shows what the turn would have done.
  - `retrievals` can supply the past run's retrieved facts. `sessionApproval` gives the past run's decision at the session approval gate, which the replay follows (a recorded rejection fails the turn with `hitl-rejected`). Without a recorded decision the gate is skipped, and the result says so.
  - `tool.completed` events carry `replay: 'live' | 'recorded' | 'refused'`.
- `@kindgi/runtime`: `RunReplayRef`; `replay` on `runGraph` and `startRun`; `replayOf` and `evalRunId` on `KernelRunRecord`; `replays` and `evalRunId` on `ListRunsInput`.
- `@kindgi/capabilities`: `ModelUsageRecord.replay` tags a replay's model calls with the past run and the eval run.
- `@kindgi/api`:
  - A run carries `replayOf` and `evalRunId`.
  - `GET /v1/runs` leaves replay runs out unless `replays=include|only`; `evalRunId` lists one eval run's replays.
  - A judged agent turn's captured `context` also keeps `sessionApproval`, the decision at its session approval gate.
- `@kindgi/client`: `runs.list({ replays, evalRunId })`; the Python client too.
- `@kindgi/cli`: `kindgi runs list --replays=<exclude|include|only> --eval-run=<id>`.
