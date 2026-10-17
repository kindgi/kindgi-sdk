---
"@kindgi/api": patch
"@kindgi/authz": patch
---

**What a caller is shown about its own access no longer fills the access audit.** A console reads whoami's `tenantAdmin`, `GET /v1/identity/me/permissions` and a judging queue item's `can` again and again, and each read left a row in the tenant's access audit: allowed for a tenant admin, denied for everyone else. They're decided as before, and recorded nowhere. Every decision on what a request may do or read is recorded as before, allowed or denied.
- `AuthzCheckBinding` (`@kindgi/authz`) takes an optional `probe`: the decision `check` makes, recorded nowhere. A binding without it answers these reads through `check`, which records them as before. A refusal the API decides from the caller's own limits (a `member` session or key asking whether it's a tenant admin, or one limited to a project) isn't recorded on these reads, with or without it.
- `Authorizer` (`@kindgi/api`) has an optional `probe(c, action, resource)`, which `createAuthorizer` always provides: `can`'s answer, from the caller's own limits first, then the binding's `probe`, else its `check`. It's only for what a response shows the caller. A route decides with `can`, `authorize` or `filterByCan`, which record.
