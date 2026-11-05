---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/client": patch
---

**An approval gives the id of the connection its call acts with, so a person can see which of their accounts it uses.**

An approval still names no account of a person's own connection: it's built from the run's record, which any project reader reads and which never names it. With several accounts of one app, "this person's Google account" didn't say which. `ApprovalConnection` (on an approval, and in a run's `waitingFor`) and `HitlEnqueueInput.connection` gain the optional `connectionId`, for a company connection too. Whoever may read the connection, its person or a tenant admin, looks its account up by it with `GET /v1/connections/{connectionId}`. Anyone else gets that route's `404`, and the approval reads as before. Approvals from before this change have no `connectionId`.

- `@kindgi/agents`: the connection gate sets `connectionId` on the approval it asks for, from the run's record.
- `@kindgi/api`: `ApprovalConnection.connectionId`, on `GET /v1/approvals`, `GET /v1/approvals/{approvalId}` and a run's `waitingFor`.
- `@kindgi/client`: the wire types gain the field.
