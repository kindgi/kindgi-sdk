---
"@kindgi/api": patch
"@kindgi/client": patch
---

What the caller may do, in one call, so a client can hide what the caller can't do instead of offering it and answering 403. It's optional for a runtime: without a `MyAccessBinding` the route answers `501 permissions-unsupported`, and a client reads whoami's `tenantAdmin` and `reviewerRole` instead.

**`GET /v1/identity/me/permissions`** answers for the caller as authenticated:
- **`tenant`:** `{admin, member?}`. `admin` is decided as the admin routes decide it.
- **`reviewer`:** `{role, decides, canDecide}`, when the caller is a reviewer.
  - `decides`: the required roles it may decide, its own rank and below.
  - `canDecide`: false when its token has a reviewer role but no user or roster row.
- **`key`:** `{tokenId, role?, projectId?}`, when the caller is an API key.
- **`tokenCapabilities`:** the capabilities the token carries, which secret, env and signing-key writes need. A sign-in session carries none; an API key carries those it was minted with (none by default).
- **`projects`:** the projects the caller may read, by name. Each has its effective `role` (`owner` > `admin` > `editor` > `viewer`) and `via`, every way it holds one:
  - `direct` or `team`, with `since` when the runtime keeps it;
  - `org-admin`;
  - `tenant-admin`.
- **`orgs` and `teams`:** the caller's own, with its role in each.
- **`capabilities`:** what each project role allows on the project and each object type in it, from the runtime's authorization model. A client decides an action as `capabilities[project.role][type]` holding it.
- **`readOnlyNotice`:** the line a console shows someone who may only view a project, when a tenant admin set one. It's in the tenant config, `kind: 'config'`, key `console.readOnlyNotice`, plain text on one line, at most 280 characters.

**The key's limits are applied:**
- a `member` key is never tenant admin;
- a key limited to a project sees that project alone, and administers no org or team.

**Only what the caller may see:** no project it can't read, nobody else's role. The server still checks every call. `503 authz-backend-unavailable` when the authorization store can't be read.

**Clients:**
- **TypeScript:** `client.identity.me.permissions()`, typed `MyPermissions`.
- **Python:** `client.identity.me.permissions()`, with the `MyPermissions` models.
