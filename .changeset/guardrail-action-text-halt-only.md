---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/guardrails": patch
"@kindgi/specs": patch
---

**A guardrail's `action` is described as what it does in 0.1: only `halt` acts.** The OpenAPI `GuardrailAction` description, the guardrail YAML schema (`guardrail.schema.json`, both its `on-violation` text and its top-level description), the `Guardrail.action` and `OnViolation` docs and the package description of `@kindgi/guardrails`, the TS client's `GuardrailAction`, the Python client's model and the Python SDK README now say the same as the guardrail skills: a failed `halt` check fails the turn with `guardrail-violation`, and any other value, `retry`, `escalate`, `compensate` and custom names included, is recorded as a violation and the turn completes. They no longer say that `retry` runs the step again, that `escalate` routes to review, that `compensate` calls a tool, that a custom name needs an action handler registered (the runtime registers none), or that a `retry` action needs `maxAttempts` (only a `retry` object, when given, needs it). `retry`, `escalateTo` and `compensateWith` gain descriptions saying nothing acts on them in 0.1. No behaviour changes, and no shape changes.
