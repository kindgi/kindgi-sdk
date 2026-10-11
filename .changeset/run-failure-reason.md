---
"@kindgi/api": patch
"@kindgi/client": patch
---

A failed run's `failure` carries the error's own `reason` when it gives one, e.g. `reason: "timeout"` on a turn whose approval nobody decided in time (`hitl-cancelled`), so a caller no longer reads it from the message. It's optional: a runtime from before this release doesn't send it.
