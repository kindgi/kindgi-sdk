---
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A pack service run per deployment can be given the secrets its pack declares, when the orchestrator asks for them.**
- **`GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env?secrets=values`** gives each declared name that's set only as a secret in `secrets`, as `{ value, revision }`, beside the plain values in `env`.
  - Each is read at the version its revision names. A secret that changes while it's read is read again once, and then the answer is `503 pack-env-unavailable`.
  - The `revision` (`ps1-…`) is made from the name's part of the deployment's revision, never from the value, so it changes whenever what's given for the name does.
  - Every secret given is audited before the answer: one `secret-resolved` row each (caller `pack-env`, with the deployment id and the revision), all written in one append. When they can't be written, none is given (`503 pack-env-unavailable`). A server with no audit store gives none (`501 pack-env-secrets-unaudited`).
  - It's given only to a key holding `system:pack-env` itself. Any other key asking for it, `kindgi:system` included, is refused (`403 system-scope-missing`), with nothing read.
  - A secret that can't be read for a reason the platform fixes, not the owner, is `pack-env-secret-unreadable`, and no value is given. The store's message is never passed on.
  - Without `secrets=values`, the answer is as before: such a name is `pack-env-secret-not-yet`.
- **`GET /v1/system/pack-env`** lists a pack service held as `pack-env-secret-unreadable` or `pack-env-secrets-unaudited` at its current revision every time, with its `held` code: the revision doesn't move when the platform fixes it. `PACK_ENV_PLATFORM_HOLDS` names them.
- **New codes:** `pack-env-secret-unreadable` (a problem), and the orchestrator's own `pack-env-secrets-unaudited`, `pack-env-secret-too-large`, `pack-env-secret-capacity` (an endpoint's problem) and `pack-env-secret-redeploy` (a ready service's hold).
- **The owner's check** (`GET /v1/deployments/{deploymentId}/pack-env`) lists a name set only as a secret as `kind: 'secret'` with no problem, read without its value. `kindgi deploy --hosted` says why for each new code, and says the platform's team is told for the ones it fixes.
- **`@kindgi/compliance`:** `resolveEvent` builds a resolve event for a caller that appends its own rows. The `pack-env` caller is new, and a resolve event can carry the revision and the deployment id.
