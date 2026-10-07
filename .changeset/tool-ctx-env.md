---
"@kindgi/tools": patch
"@kindgi/agents": patch
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
"@kindgi/env-schema": patch
"@kindgi/cli": patch
---

**A tool's env values, per project (`ctx.env`).** A tool that declares names in `needsSpec.env` gets their values in `ctx.env` on each call: the call's project's value, else its org's, else the tenant's, in the env the runtime serves (`KINDGI_ENV`). A schema `default` makes a name optional. The values a call used are recorded with it (`ToolContext.record`, new: the step's durable record, set by the dispatch site), so the call re-run after a wait or a retry sees the same ones. A runtime that resolves them is needed; with an older one, `ctx.env` stays absent.

- **`@kindgi/tools`:** `ToolContext.env`; `ToolContext.record`, which an agent turn's tool dispatch (`@kindgi/agents`) sets to its step's record under `tool-call:<call id>:<tool id>:<key>`; and `TypedNeeds` documents what `env` and `secrets` take (strings, checked by their schema; `config` is reserved).
- **Pack protocol 2.5.0** (`@kindgi/specs`, `@kindgi/handler-runtime`, the Python SDK): `callContext.env` holds the declared names' string values. It's additive: a pack service that predates it already passes it through.
- **`kindgi env set/list/unset --scope=tenant|org:<id>|project:<id> --env=<name>`** act on the runtime's env values (`/v1/env`). Without `--scope` they edit the pack's local env files, as before. `--env` is required with `--scope`. `set` refuses to change a value without `--force`, and warns about a name that looks like a credential. A runtime that doesn't serve `/v1/env` gets a plain message.
- `kindgi env`'s description now says what it manages. It used to say values "resolve into `needs.env` at deploy time", which nothing did.
