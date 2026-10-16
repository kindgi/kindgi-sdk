---
"@kindgi/api": patch
---

**A person who is the tenant's admin reads approvals at every tier.** With authorization on, `GET /v1/approvals` and `GET /v1/approvals/{approvalId}` let a person who is the tenant's admin read approvals in the projects they may read. With no roster entry, they read as an `admin` reviewer. With a lower role on the roster, they read their own tier, and any tier they ask for (`requiredRole`, or one approval).
- **No one new gets this:** a tenant admin could already register themselves as an `admin` reviewer.
- **Deciding and signing an audit bundle stay the roster's.** An API key reads as its user does, within its own limits: a key with no user, a `member` key and a key limited to a project read nothing new.
- **Anyone else is answered as before:** a tier above their own is still `403`, and one approval above it is still `404`.
- **The roster doesn't show such a reader.** The access audit records the tenant-admin check (`authz-decision`), made only where it changes what the roster gives: a reviewer reading their own tier makes none.
