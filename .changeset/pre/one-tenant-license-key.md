---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A runtime serving one tenant mints a system key for the license renewal, so the renewal can send the deployment's use.**
- `/v1/system/keys` (mint, list, revoke) answers the deployment's own token on a runtime serving one tenant too. There it mints keys holding `system:license` alone: a mint asking for any other scope, or for `kindgi:system`, gets `400 bad-input`. With a `systemAccessAudit`, each mint, list and revoke is on the system access record, as the deployment's own token (`boot`).
- Such a key reads `GET /v1/license` and `GET /v1/license/usage`, and nothing else. A tenant's route refuses it (`403 system-key-on-tenant-route`), and so does every `/v1/system/*` route (`403 system-scope-missing`).
- A system key holding anything but `system:license` (one minted while the runtime served many tenants, say) is refused on every route with a new code, `403 system-key-scope-not-served`. Its `details` name the key's `scopes` and the ones `served`.
- `TokenResolution` takes `systemKeysOperator`, a `SystemPrincipal`. A runtime serving one tenant sets it on its own token, which is then that system principal, with the full system capability, on `/v1/system/keys` alone. Everywhere else the token is the tenant's, as before.
- `systemPrincipalFence` applies these rules unless its `tenancy` is `multi`. Among them: the deployment's own token (`boot`) as a system principal is refused outside `/v1/system/keys` (`403 system-principal-required`), whatever the bearer makes of it.
- `@kindgi/client`: `SystemKeysClient`'s docs cover a runtime serving one tenant.
- `@kindgi/cli`: `kindgi license renew --runtime-token` names a system key holding `system:license` as what it can read, beside the runtime's own token.
