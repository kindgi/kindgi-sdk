---
"@kindgi/policy-contract": patch
"@kindgi/api": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
---

Two retention domains: `memory` and `conversation`. A `memory` policy purges, past its grace, every revision of a fact whose life ended (deleted, or its current revision past its expiry); a fact under legal hold is never purged. A `conversation` policy purges unregistered conversations with their messages and recall index. Both hold people's words, so their retention is opt-in: a `*` policy doesn't reach them, only a policy naming them does.
