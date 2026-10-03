---
"@kindgi/env-schema": minor
---

`KINDGI_LICENSE_KEY`: the commercial license key (`kgi_lk_...`) the server checks offline at startup outside development mode. Without a valid key, a server that isn't in development mode refuses to start; `KINDGI_DEV=true` needs none. `LICENSE_KEY_VAR` names it.
