---
"@kindgi/api": patch
---

`GET /v1/runs?scopeKind=project|org&scopeId=…` with a `scopeId` that isn't a UUID is `400 scope-invalid` ("scope query parameters malformed: scopeId must be a project id (a UUID), got …"), before any query; it reached the database's uuid cast and failed there. The runs list now reads its scope as approvals, conversations and provenance do.
