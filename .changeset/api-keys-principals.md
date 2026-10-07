---
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/client": patch
---

API keys act for a person or a service account, with that principal's grants. All of it is optional for a runtime: what it doesn't wire, it doesn't mount.
- **Whom a key acts for:**
  - `POST /v1/tokens` takes `for` (`{kind: 'user' | 'service-account', id}`), the caller by default.
  - Only a tenant admin mints for someone else, or mints an `admin` key. A key's record and `GET /v1/identity/whoami` carry `principal`; whoami also gives a key's `tokenId`, `role` and `projectId`.
  - Anyone may list, read and revoke their own keys. A tenant admin sees every key, and `?principal=user:<id>` filters to one principal's. Someone else's key reads as `404`.
  - A token that names no principal works as before: tenant admins only, and the key is a service account of its own.
- **A key's `role` is a ceiling.** A `member` key takes no `admin` action, even for an admin. The authorizer applies a key's limits in `filterByCan` too, so a list never shows what the key can't reach.
- **A key's `projectId` is a limit:**
  - A request naming another project, in the path (`/projects/<id>`), the query (`projectId`, or `scopeKind=project&scopeId`) or a write body (`projectId`, `scope.projectId`), is `403 key-project-mismatch`.
  - Such a key takes no `admin` action on the tenant, an org or a team, and mints only keys limited to the same project.
  - It reaches only its project's resources (an agent, a run, a secret, …): the authorizer asks the authorization store with the new optional `AuthzCheckBinding.inProject` from `@kindgi/authz`. A store without it limits the key to the project itself.
- **Refusals:**
  - `404 principal-not-found`: `for` names nobody.
  - `403 role-exceeds-principal`: an `admin` key for a principal who isn't a tenant admin.
- **Service accounts** (`/v1/service-accounts`, tenant admins, with a `ServiceAccountBinding`):
  - Create one with its first grants (tenant admin, or a role on a project); list, get, `grant`, `ungrant`, and `unregister` (a tombstone: its grants go and its keys stop working).
  - Errors: `404 service-account-not-found`, `409 service-account-name-taken` and `409 service-account-unregistered`.
- **Revoking sessions:** `POST /v1/identity/users/{userId}/revoke-sessions` now needs a tenant admin, unless the caller revokes their own sessions (`403 permission-denied`). Any caller could revoke anyone's before.
- **Add a person:** `POST /v1/identity/users` (`{displayName, primaryEmail?}`), tenant admins only. It is mounted when the identity directory implements the new optional `createUser`. An email another person already has is `409 identity-user-email-taken`.
- **TypeScript client:**
  - `tokens.create({ for })`, `tokens.list({ principal })`, the new `serviceAccounts` resource, and `users.create` (it used to throw `not-yet-wired`).
  - The new error codes are classified.
- **Python client:** `tokens.mint(for_=…)`, `service_accounts.*` and `identity.users.create`.
