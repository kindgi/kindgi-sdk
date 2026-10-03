---
"@kindgi/env-schema": minor
---

`KINDGI_DEV` (development mode; boolean like `KINDGI_DOCS`) and the `dotenv` secrets backend: `KINDGI_SECRETS_BACKEND=dotenv` reads and writes `.env` files in `KINDGI_SECRETS_DOTENV_DIR` (required), optionally narrowed by `KINDGI_SECRETS_DOTENV_FILES` (default `.env,.env.local`). `EnvTarget.secretsBackend` accepts `dotenv`. The server allows the `dotenv` backend only in development mode.
