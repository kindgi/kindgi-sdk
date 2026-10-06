---
"@kindgi/env-schema": patch
"@kindgi/cli": patch
---

`KINDGI_PUBLIC_URL`: the URL clients reach the runtime at, when it isn't the address the server binds (behind a proxy, or a container whose port is published on another one). The runtime's startup banner names it, with its docs and console links. `kindgi dev` sets it, so the banner shows the port `kindgi dev` chose, e.g. 4001 when 4000 was taken, not the container's 4000. `parsePublicUrl` validates it; a runtime that doesn't read it keeps working.
