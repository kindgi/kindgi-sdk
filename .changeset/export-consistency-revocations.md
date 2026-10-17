---
"@kindgi/cli": patch
---

**`kindgi exports create` says a closing or suspended workspace's revocations can change its export too.** The manifest's `consistency` line for a closing or suspended workspace now reads "nothing in it changes but deletes, revocations and erasures, so the files agree with each other, but for one of those made while the export ran". It said deletes and erasures only, but such a workspace can still revoke an API key or a signing key, and the export reads both.
