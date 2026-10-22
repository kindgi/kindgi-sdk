---
"@kindgi/env-schema": patch
---

Four descriptions now say what the server does. `KINDGI_ERASURE_SHARED_WAIT_MS` is at least 3600000 (an hour), or the server refuses to start. `KINDGI_SESSION_TTL_MS` and `KINDGI_SESSION_IDLE_TIMEOUT_MS` say the server refuses to start below their minimum, and when either is set where nobody can open a browser session (sign-in with identity providers off and console token sign-in off). `KINDGI_SESSION_TTL_MS` below an hour needs `KINDGI_SESSION_IDLE_TIMEOUT_MS` set no longer than it, since the idle default is an hour. `KINDGI_PACK_SERVICE_TOKEN` suggests `openssl rand -hex 32`, as its error message already does, and so do the self-host and rotate-keys guides.
