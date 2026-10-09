---
"@kindgi/client": patch
---

The TypeScript client's docs no longer say `auth.refresh` is called when a token expires: nothing calls it yet. On an `auth` error with reason `token-expired`, get a new token and make the call again.
