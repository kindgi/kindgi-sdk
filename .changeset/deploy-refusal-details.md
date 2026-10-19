---
"@kindgi/api": patch
---

**A deploy refused for a guardrail it can't keep now answers with `details.primitive` and `details.id`.** `POST /v1/deployments` answers `409 guardrail-project-mismatch` or `409 guardrail-already-registered` when the deploy decides the refusal itself: a live guardrail in another project, or one in its own project with a different definition. From the built package, those answers came without the two fields. The deploy's other refusals had them, and are unchanged.
