---
"@kindgi/cli": patch
"@kindgi/env-schema": patch
---

**`kindgi dev` offers connections.** An agent or a flow can use your own app at a provider on your laptop, as on a deployed runtime.
- `kindgi dev` keeps connections' tokens in its database, encrypted under a key pair it makes for that database in `~/.kindgi/dev/connections/<database>/`: each key a file only you can read (`0600`), in a folder only you can open (`0700`), given to the runtime read-only and never printed. `--reset` of the bundled database removes its pair with it; a database you name keeps its pair.
- Its start says whether connections are on, with the redirect URI your apps need: `Connections  on · redirect URI http://127.0.0.1:4000/console/connect/callback · register your app in the console (Connection apps)`, or `off` and why. A runtime image that doesn't say shows `off, this runtime image doesn't say`.
- The first start on a port the database hasn't used says, once, to add that port's redirect URI to each of your apps.
- When the runtime refuses to start because a database's tokens were stored under other keys, `kindgi dev` names the key file and the ways out.
- The follow-up template's README says how to send for real under `kindgi dev`.
- `@kindgi/env-schema`: `KINDGI_CONNECTIONS_STORE` (development, with the `dotenv` backend): `none`, the default, or `postgres`, the database under a local key. `KINDGI_SECRETS_BACKEND_KMS`'s description names its use there.
