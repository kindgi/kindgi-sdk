---
"@kindgi/api": patch
---

**`GET /v1/deployments` answers `503` when the database is busy, and more `500`s stop repeating an error's own message.** The deployments list built its own `500` in a `catch`, so a busy-database error became a `500` instead of the `503` + `Retry-After` the central handler gives a read; it now lets the error through. The deployments write paths and the signed-export failures that put a thrown error's, an outcome's or a signing error's message into a `500` body route through the handler too: the body carries a fixed message and the cause goes to the log. The public wire codes are unchanged (`export-key-error`, `compliance-export-failed` and `persistence-error` on the signing `500`s; `signing-key-not-found` stays a `4xx`), and the fixed-string wiring errors are left as deliberate client messages.
