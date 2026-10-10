---
"@kindgi/tools": patch
"@kindgi/agents": patch
"@kindgi/api": patch
---

**A replay sends a read-only tool the env values the past run's call saw.** A comparison that replays a run (a candidate agent version over a test set) runs some read-only tools live. Those tools now read the config the past run read, not today's, so an env value changed since then can't skew the judged deltas.

- **`@kindgi/api`:** a judged run's copy keeps `context.toolEnv`, each tool's recorded env values by tool id. It's taken from an agent turn's calls and from a flow's tool steps, agent steps and sub-flows. It's optional in the spec, and a run from before env was recorded has none.
- **`@kindgi/agents`:** a replay binding's `live` decision can carry `env`. The turn journals it with the decision, keeps it out of the replay report, and sends it as the call's `ctx.env`. Names it doesn't hold (a tool version that declares more) resolve as usual.
- **`@kindgi/tools`:** `toolCallRecordKey` and `TOOL_ENV_RECORD_KEY` name where a call's `ToolContext.record` decisions are journaled, so dispatch sites and capture agree.
