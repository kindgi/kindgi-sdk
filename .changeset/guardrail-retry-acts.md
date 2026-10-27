---
"@kindgi/agents": patch
"@kindgi/guardrails": patch
"@kindgi/specs": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**A `retry` guardrail sends a failed answer back to the model, for a new one.** Before, `on-violation: 'retry'` was only recorded, as `log-only` is, and the turn completed. Now, in an agent turn with a `retry` guardrail:
- Each finished answer, after output repair, is judged on the turn's `halt` and `retry` guardrails. A failed `halt` fails the turn at once. A failed `retry` adds the answer and a user message naming the guardrails and their checks' reasons (`[kindgi:guardrail-retry] ["<id>",…]`), and the model writes a new answer.
- `retry.maxAttempts` counts the answers a guardrail fails, the first one included: with 3, it sends a failed answer back up to twice, and the third answer it fails ends the turn. Left out, it's 2. When a guardrail's attempts run out, or the agent's `budget.maxSteps` does, or the loop's 32 model calls do, the turn fails with `guardrail-violation`: its message says "after N answers", and `GuardrailViolationError.attempts` (and the wire's `details.attempts`) says how many answers the turn had.
- The other guardrails judge only the answer that's sent, once. A sent-back answer and its note aren't stored in the conversation.
- The outcome ledger gets a set of rows per answer judged, under the step `budget-check@<iteration>`, so a guardrail's counts are of answers judged. A turn without a `retry` guardrail is judged and recorded as before.
- The loop's iteration output and `agent.turn` 1.1.0 are unchanged, so a run journaled by either version resumes on the other. A turn resumed in another process after its last answer was judged in the loop judges that answer on its `halt` and `retry` guardrails again, since what the loop judged is kept in memory only; a `retry` failure there fails the turn as out of attempts.
- A dry run records a `retry` guardrail's failure and sends nothing back.

`categorizeOutcomes` sorts `retry` failures into a new `retry` list, out of `other`. `GuardrailViolationError` and `describeBlockingViolations` take the attempts. `@kindgi/guardrails`' `retryHandler` takes a `retry` action without `action.retry` (the default attempts apply). The `Action`, schema, OpenAPI and SDK docs say what `retry` does; `@kindgi/client`'s `GuardrailViolationError` gains `attempts`. The guardrail skills say it too: `kindgi-authoring-guardrails` 0.3.11, `kindgi-python-authoring-guardrails` 0.1.6, `kindgi-java-authoring-guardrails` and `kindgi-scala-authoring-guardrails` 0.1.3. The agents skills say that a `retry` guardrail sends the answer back: `kindgi-authoring-agents` 0.4.9, `kindgi-python-authoring-agents` 0.1.8, `kindgi-java-authoring-agents` and `kindgi-scala-authoring-agents` 0.1.5.
