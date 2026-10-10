---
"@kindgi/api": patch
---

A tenant's sign-in history: `GET /v1/audit/sign-ins`, a tenant admin's to read. It lists who signed in and out, how (`method`: `api-token`, `email-link`, `google`, `microsoft`, `github`, or a workspace identity provider), when and from where (`clientAddress`), what was refused and why, and the emailed links sent or capped. `?userId=` narrows it to one person's own sign-ins and sign-outs, and `?kind=`, `?from=`/`?to=`, `?order=desc` and cursor paging work as on `/v1/audit/authz`. Anyone else gets 403 `permission-denied`.
