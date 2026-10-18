---
"@kindgi/api": patch
---

**The tenant config's values are read and written under the env the runtime serves.** `GET` and `PATCH /v1/tenant/config` now keep `env` and `secret` entries (and any sent with `sensitive: true`) under the env the runtime serves (`createApp`'s `envName`, which whoami names as `servedEnv`), where its tools read them. Before, they were under `default`, so on a runtime serving `prod` a pack tool never read a value set there.
- **`config` entries stay under `default`,** whatever the runtime serves: they're the tenant's own settings, not an environment's, so one set before (`console.readOnlyNotice`, say) still applies and is still listed. `GET` lists them as `kind: 'config'` when they live apart from the values.
- **A runtime that serves no env** keeps every entry under `default`, as before.
- **`env` and `secret` entries set before under `default`** stay there, and the tenant config no longer lists them. Pack tools and webhook triggers didn't read them; a model provider, tool or endpoint that names one under `default` still does. Set them again, and find or remove the old ones under `default` with `/v1/env` and `/v1/secrets`.
