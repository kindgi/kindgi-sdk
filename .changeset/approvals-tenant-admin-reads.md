---
"@kindgi/api": patch
---

**A person who is the tenant's admin reads approvals.** With authorization on, `GET /v1/approvals` and `GET /v1/approvals/{approvalId}` take a person who is the tenant's admin as an `admin` reviewer, with no roster entry, so one person can read every approval in the projects they may read.
- **The same people as before could already:** a tenant admin may register themselves as a reviewer.
- **Deciding and signing an audit bundle stay the roster's.** An API key reads as its user does, so a key with no user, a `member` key and a key limited to a project read nothing new.
- **The roster doesn't show such a reader.** The access audit records each read's tenant-admin check (`authz-decision`).
