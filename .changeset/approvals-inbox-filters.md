---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A reviewer's inbox in one read.** `GET /v1/approvals` takes:
- `status` with several values, repeated or comma-separated (`status=pending,assigned,in_review`), as `GET /v1/runs` does. One status works as before; an unknown one is `400 bad-input`.
- `assignedTo=me`: only the approvals assigned to the caller's own reviewer row (none when it has no row).
- `order=asc`: oldest first. The page's `nextCursor` continues its own order, and a cursor can't continue the other order (`400 bad-input`). The page says which order it's in (`order`); a runtime before 0.1.6 leaves it out and lists newest first.

`HitlBinding.listApprovals` takes optional `statuses`, `assignedTo` and `order`, and says the order it applied (`order` on its result). The route keeps a page right from a binding that ignores the filters. The client takes `status` as one or a list, `assignedTo: 'me'` and `order`, and returns the page's `order`. The Python client takes one value or a list for every repeated query parameter. The CLI adds `kindgi approvals list --status=<a,b> --assigned-to=me --order=asc`.
