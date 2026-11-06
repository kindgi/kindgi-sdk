---
"@kindgi/api": patch
---

When the authorization store can't be reached, a request answers `503 authz-backend-unavailable` with `Retry-After: 5`, not `500 internal-server-error`, where sending it again is safe: a check in the `authorize` middleware, which runs before the handler, on any method, and a check inside a handler on a `GET` or `HEAD`. A check inside a handler on any other method still answers 500, since the handler may have written before it. The runtime's authorization binding marks such a failure `code: 'authz-backend-unavailable'`, on the error or down its `cause` chain; a binding that doesn't mark it answers 500, as before. `GET /v1/identity/me/permissions`, which already answered `503 authz-backend-unavailable` when the store couldn't be read, now sends `Retry-After` with it.
