---
"@kindgi/api": patch
---

**`GET /v1/guardrails` and `GET /v1/guardrails/{guardrailId}` give a guardrail's `at` and `sees`.** The `Guardrail` schema has both, but the response left them out, so a reader couldn't tell where a guardrail runs or what its check sees. A guardrail that names neither still gives neither: it runs at the final answer and sees the turn, the schema's defaults.
