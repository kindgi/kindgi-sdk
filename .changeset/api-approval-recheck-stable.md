---
"@kindgi/api": patch
---

**`approval.recheck` is a stable gate check name.** An approval adds it to a promotion it supersedes, with a message that says what changed since the check, such as the version serving the scope or its release gate policy. `kindgi agents promote --wait` and `kindgi promote --make-live --wait` print that message.
