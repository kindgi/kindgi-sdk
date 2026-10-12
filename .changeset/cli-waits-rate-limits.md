---
"@kindgi/cli": patch
---

`kindgi deploy`, `kindgi flows publish`, `kindgi agents publish` and `kindgi blocks publish` wait out the server's rate limits, which it answers with `429 rate-limit-exceeded`. On a `429` with a `Retry-After`, they wait that long and send the same request again (`kindgi deploy` with the same `Idempotency-Key`), printing one line on stderr per wait, such as `The server's schema-compile-time limit is reached: sending it again in 23s.`. They wait 10 minutes at most in all; past that, or on a 429 without a `Retry-After`, or on any other error, they fail as before.
