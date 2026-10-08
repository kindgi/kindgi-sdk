---
"@kindgi/env-schema": patch
---

New runtime settings for "Continue with Google / Microsoft / GitHub" with the deployment's own apps: `KINDGI_AUTH_GOOGLE_CLIENT_ID` and `KINDGI_AUTH_GOOGLE_CLIENT_SECRET` (or `…_SECRET_PATH`), and the same for `MICROSOFT` and `GITHUB`. People who've been added to a workspace sign in with that account, by its verified email.
