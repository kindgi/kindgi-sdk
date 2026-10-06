---
"@kindgi/compliance": patch
---

**Compliance evidence says who acted.** `GET /v1/compliance/evidence` (and `auditEventToEvidence`) now returns each item's `actor` as `{ kind, id }`, read from the audit event it comes from (`user:<id>`, `agent:<id>`, …). Before, the actor was dropped, so evidence of an authorization check or an approval decision didn't say who made it. An actor of a kind evidence can't name (outside `user`, `agent`, `system`, `admin`, `external`) is left out.
