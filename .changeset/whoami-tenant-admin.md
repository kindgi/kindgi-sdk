---
"@kindgi/api": patch
"@kindgi/client": patch
---

A console signed in with a cookie session knows who is a tenant admin again.
- **`GET /v1/identity/whoami`** answers `tenantAdmin`: whether the caller is a tenant admin, decided as the admin routes decide it. That's `admin` on the tenant when the runtime authorizes; otherwise the `tenant-admin` scope of a full key, never a `member` key or one limited to a project. A console shows its admin pages by it. The field is optional: from older servers it's absent, so read `scopes`.
- **A session opened with an API token (`POST /v1/auth/token-sign-in`) carries the key's scopes**, so it acts as the key did. Before, it had none, so with authorization off (`kindgi dev`, or a deployment without OpenFGA), even the deployment's own token lost admin once it signed in to the console. The session can't do more than the key: member and project keys still can't sign in, a key's scopes never change, revoking the key ends its sessions, and with authorization on the authorizer decides. Sessions from an identity provider are unchanged.
