---
"@kindgi/tools": patch
"@kindgi/agents": patch
---

**A run's record says when a call's tool is handed its connections.** The gate records its ready answer before the call's approval, and the call's tokens are asked again right before its tool runs, so that ask can still stop the call: its connection changed, or a renewal failed. Before, a reader couldn't tell such a call from one that ran unless it had the call's result, and a running or failed turn has none. A call that ran once, then had its token refused and its renewal fail, couldn't be told apart either.

- `@kindgi/tools`: `ConnectionGateRecord` gains `kind: 'ran'`, and its `ready` record gains `recordsRan`, set by a gate that records the handover. A `ran` record means the call's tool was handed its connections, right before its first run on them. A call whose input then failed the tool's input check has one too, and its tool didn't start: its result says the input failed. With `recordsRan`, a call with no `ran` record didn't run. Older records have neither. `connectionGateRecordOf` never builds `ran` and never sets `recordsRan`.
- `@kindgi/agents`: an agent's call records `ran` under `connection-gate:<call id>:ran:<attempt>`, once per attempt of its step, right before its tool's first run on the connections it got. A renewed run after the app refused a token records no other. Its gate's `ready` records set `recordsRan`.
