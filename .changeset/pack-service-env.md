---
"@kindgi/env-schema": minor
---

The pack service's variables, and the server's for reaching it.

- **The `component` axis.** `EnvTarget.component` is `server` (the default) or `pack-service`, the separate process that runs a pack's code. The server's vars don't apply to the pack service's target.
- **The `packTransport` axis.** `EnvTarget.packTransport: 'http'` is set when the server calls a pack service at `KINDGI_PACK_SERVICE_URL`. Its token is then required.
- **New vars,** in a new `pack-service` group:
  - `KINDGI_PACK_SERVICE_URL`: the server's address for the pack service. Unset, no pack code runs.
  - `KINDGI_PACK_SERVICE_TOKEN`: the secret shared by the server and the pack service. Required by the pack service, and by the server with an HTTP pack transport.
  - `KINDGI_PACK_CALL_TIMEOUT_MS`: how long one pack call may take (default 120000).
  - `KINDGI_PACK_INDEX` and `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`: the pack service's index path (default `/app/index.json`) and call cap (default 32). The pack service already reads both; they're declared here now.
