---
"@kindgi/env-schema": minor
---

`KINDGI_DEV_HOST_ALIAS` (development only): where the server's outbound calls to a loopback address connect instead. Inside a container, loopback is the container itself, so webhooks to the app, HTTP MCP endpoints, a model provider and the pack service on the developer's machine would all miss. `kindgi dev` sets `host.docker.internal` on Docker Desktop. The URL, the `Host` header and the TLS server name stay as written; only the connection goes to the alias.
