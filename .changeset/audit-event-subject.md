---
"@kindgi/audit-events": patch
"@kindgi/audit-events-inmemory": patch
"@kindgi/api": patch
---

A person's sign-in history includes the events about them: when an admin ends someone's sessions, it shows on that person's history, saying who did it, and no longer on the admin's.
- **Audit events gain an optional `subject`:** the principal an event is about, when that isn't its actor (the person whose sessions an admin ended, or the person an anonymous request named). `AuditEventFilter.subject` matches events about a principal: `subject` where an event has one, else `actor`.
- **Bindings say whether they filter by it:** `AuditEventBinding.filtersBySubject`. The in-memory binding does. `GET /v1/audit/sign-ins?userId=` filters by `subject` with such a binding, and by `actor`, as before, with one that doesn't say so.
- **The sign-in event on the wire:** `userId` is the person the event is about, and the new `byUserId` is who acted, when that isn't them (the admin who ended their sessions).
