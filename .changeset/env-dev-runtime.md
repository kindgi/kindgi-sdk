---
"@kindgi/env-schema": minor
---

The server binary's development settings, so `kindgi dev` can run the runtime as a container:

- `KINDGI_API_HOST` (core): the address the API server binds. Default: all interfaces. `127.0.0.1` keeps it off the network.
- `KINDGI_PACK_DIR` (development only): the pack directory `kindgi dev` runs. The server reads the pack's primitives from the index `kindgi dev` writes there (`.kindgi/dev/index.json`) instead of from Postgres, and signed deployments are off.
- `KINDGI_DEV_CONSOLE_LOGIN` (development only): the console logs in by itself through `GET /__dev/bearer`, which answers loopback hosts only.

The development settings form a new `dev` group, listed last in `.env.example`. `KINDGI_DEV`'s description now names them.
