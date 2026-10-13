---
"@kindgi/api": patch
---

**A `501` is logged at `info`, not `error`.** A `501` answers a route this runtime doesn't offer, such as `GET /v1/identity/me/permissions` on a runtime without an access store (`kindgi dev`'s), and nothing failed. So the console's routine read no longer prints an `ERROR` line. Its access line is now at `info`, like a `4xx`. Every other `5xx` stays at `error`.
