---
"@kindgi/guardrails": minor
"@kindgi/agents": patch
---

Guardrail checks stop when the turn does.

- `@kindgi/guardrails`: `EvaluationBindings.abortSignal` (optional). It fires when the caller stops waiting: the agent turn was cancelled, or ran past its wall-clock budget. The llm-judge strategy passes it to the judge's model call. A check that calls out to a model or a service should pass it on.
- `@kindgi/agents`: the turn's abort signal reaches every guardrail check. `evaluateGate` takes it as a fifth argument. Before, a slow or stuck judge, or a pack check, held the turn past its budget.
