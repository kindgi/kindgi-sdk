---
"@kindgi/api": patch
"@kindgi/connections-inmemory": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A tool's need of a connection says which permissions it asks for, and a declined connect says what it kept.** `GET /v1/connection-choices/needs` (`client.connectionChoices.needs(...)`) answers each need's `permissions`: the entry's permission keys, from the tool's `needsSpec`. A place that shows a need can then say what a connection lacks for it. The field is optional, and a binding that doesn't read them leaves it out. `ConnectionChoiceNeedRecord` has `permissions`. The `reconnects` text now says that a named reconnect asks for the permissions it lists and those the connection holds, and that a grant short of what the connection holds leaves it as it was.

- `@kindgi/connections-inmemory`: its needs answer each need's permissions, so `kindgi dev` shows them too.
- `@kindgi/cli`: a `kindgi connections connect` without `--reconnect` that's declined at the app says `Declined at <app> (not <permissions>): nothing from this sign-in was kept.` The sign-in may have been to an account the owner already has a connection of, and that connection stays as it was, so "nothing connected" could be wrong. An expired or failed connect still says "nothing connected".
