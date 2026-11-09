---
"@kindgi/api": patch
---

`GET /v1/deployments/{deploymentId}/values`, and the check a promotion makes, call a model key revoked where a run in the project reads it `revoked`, not `missing`. A run refuses that key (`secret-revoked`) rather than read a wider one. A secret store's `get` answers nothing for a revoked secret, as `SecretBinding` requires, so the check now asks the model key lookup first. The promotion was refused either way; only the reason changes.
