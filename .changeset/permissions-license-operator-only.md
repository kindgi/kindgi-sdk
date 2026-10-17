---
"@kindgi/api": patch
"@kindgi/client": patch
---

**`GET /v1/identity/me/permissions` says whether the deployment's license is held back from the caller whatever its role (`licenseOperatorOnly`), so a console doesn't ask `GET /v1/license` only to be refused.**
- `true` when `GET /v1/license` refuses the caller whatever its role: the caller isn't the deployment's own token, and the deployment doesn't serve the caller's tenant alone, as on a runtime serving many tenants. Each such refusal is recorded in the tenant's access audit, so a console that asked once per session left a refusal there for every tenant admin.
- `false` when it isn't held back and the caller's role decides: the deployment's own token reads it, and so does an admin of the one tenant the deployment serves (`tenant.admin`); that tenant's other callers are still refused.
- Absent when the deployment has no license to read or its tenants couldn't be read just then. A client that doesn't read the field asks as before.
- The field and the route make the same checks, so they never disagree.

The refusals of `GET /v1/license` and `GET /v1/license/usage` (`license-operator-only`) are now in plain words, without an environment variable's name: a tenant caller reads them in its access audit too.
