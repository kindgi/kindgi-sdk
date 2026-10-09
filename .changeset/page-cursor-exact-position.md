---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/runtime": patch
---

Paging `GET /v1/conversations`, `GET /v1/approvals` and `GET /v1/runs` no longer skips rows created in the same millisecond as the last row of a page. Postgres keeps timestamps to the microsecond, and the next cursor carried the last row's time through a JavaScript `Date`, which keeps milliseconds. So rows created earlier in that millisecond were left out of every following page; approvals also had no tie-breaker, so ones created at the same instant were skipped too. The next cursor now carries the last row's position exactly, with its id; a cursor a client already holds still answers as before. Bindings: `ConversationPage.next` (the exact position of a page's last conversation) and, for approvals, `ListApprovalsBindingInput.after` with `ListApprovalsBindingResult.exactCreatedAt`; all optional, and the routes fall back to the old cursor for a binding that doesn't give them. A cursor whose time isn't a time is now a 400 on conversations and runs, as it already was on approvals.
