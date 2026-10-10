---
"@kindgi/sdk": patch
---

The guardrails authoring skill (`kindgi-authoring-guardrails` 0.3.8) gives each built-in check's config exactly, with what's required, and says a config the check doesn't take is refused (`422 guardrail-config-invalid` when registered, `deployment-validation-failed` when deployed).
