---
"@kindgi/guardrails": patch
"@kindgi/specs": patch
"@kindgi/sdk": patch
---

**`defineGuardrail(spec, checks)` is now `validateGuardrail(spec, checks)`.** It validates a guardrail declaration against the wire schema and a check registry and returns a `Result`, as before; only the name changes, and there's no alias. The new name says what it does, beside `validateGuardrailSpec`, and leaves `defineGuardrail` free for authoring a guardrail, as `defineTool` and `defineCheck` author theirs. To upgrade, rename the import and the call. The guardrail schema's descriptions and the `kindgi-authoring-guardrails` skill name `validateGuardrail`.
