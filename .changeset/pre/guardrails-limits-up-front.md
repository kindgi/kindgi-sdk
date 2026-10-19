---
"@kindgi/sdk": patch
"@kindgi/guardrails": patch
---

**The guardrail skills and the guardrails guide say up front what a guardrail can do in 0.1.** Before, the skills listed `halt / retry / escalate / log-only / compensate` in their descriptions and said only far down that the runtime acts only on `halt`, so a coding agent asked to "block the reply and make the agent try again" planned a retry it couldn't build. The skills (`kindgi-authoring-guardrails` 0.3.10, `kindgi-python-authoring-guardrails` 0.1.5, `kindgi-java-authoring-guardrails` 0.1.2, `kindgi-scala-authoring-guardrails` 0.1.2) and the guide's overview now open with three limits:
- **Only `halt` acts.** `retry`, `escalate` and `compensate` are recorded on the turn's violations, as `log-only` is, and nothing runs the turn again, escalates or calls a tool.
- **A check sees one turn:** that turn's user message, tool calls, tool results and answer. Earlier turns aren't in its trace.
- **A check's in-memory state doesn't last:** it's lost when the pack's process is replaced (every reload and restart under `kindgi dev`, an instance stopping in a deployment), and each instance keeps its own.

They also say what works today for a check on figures, and what it doesn't cover. The `on-violation` action's docs say the same: the `Action` JSDoc in `@kindgi/guardrails`, the Python `@guardrail` docstring, and `onViolation` in the Java and Scala packs. No behaviour changes.
