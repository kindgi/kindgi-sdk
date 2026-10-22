---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A schedule or webhook runs as whoever created it, or last changed what it runs.** When anyone but the person who owns one changes its target or version, its input, its `toolsAllowedUnattended` or a webhook's signing secret (`hmacSecretName`), the caller becomes its owner, as `POST …/owner` would make them, and the change is audited as `trigger-owner-set`. So a person's own access only serves what that person set it to run. A label, the cron line, the policies or delivery settings, or the same value sent again don't move it, nor does the owner's own change. A trigger a service account owns keeps its owner; a service account that changes a person's trigger makes it the service account's. The `PATCH` answer shows the owner after the change. The owner is set before the change and put back if the change fails. A deployment whose trigger store can't change owner answers `501 trigger-operation-unsupported` for such a change, and changes nothing.
