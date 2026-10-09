---
"@kindgi/env-schema": patch
---

`KINDGI_SEED_USER_ID`'s description says what a runtime from 0.1.5 does without it. The API token's user is kept across restarts while `KINDGI_API_TOKEN` stays the same, and a changed token gets a new user, with a warning at boot. Before, a new user came at every boot. Set it to keep one user across token changes.
