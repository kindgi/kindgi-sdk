---
"@kindgi/env-schema": minor
---

`parseCorsOrigins`, `CORS_ORIGINS_VAR` and `PUBLIC_TOKEN_KEY_PATH_VAR`: the check for `KINDGI_CORS_ORIGINS` (exact origins: a scheme, a host and an optional port; no path or wildcard), so the server and the CLI refuse the same values with the same message.
