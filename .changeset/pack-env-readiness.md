---
"@kindgi/handler-runtime": minor
"@kindgi/specs": minor
"@kindgi/env-schema": minor
"@kindgi/pack-conformance": minor
"@kindgi/sdk": patch
---

A pack declares the process environment its code reads, and the pack service says what's missing.

- **`kindgi.config`** takes `env: { required?, optional? }`: the names the pack's code reads from `process.env`. The indexer validates them (environment variable names, no `KINDGI_*`, no name twice) and writes them, sorted, into `index.json` as `env`, which is absent when nothing is declared. A malformed declaration fails indexing as `config-invalid`. `resolvePackEnv` and `missingPackEnv` are exported for tools that check the same thing.
- **The pack service**, with a required name unset or empty, isn't ready: `/readyz` and every call answer 503 `{ "error": "missing env", "missingEnv": [...] }`, names only. `/v1/info` always lists `missingEnv`, and the names are logged once at startup (`missing-env`). `KINDGI_PACK_ENV_CHECK=warn` serves anyway; anything other than `strict` (the default) or `warn` fails startup.
- **`@kindgi/specs`:** `pack-index.schema.json` 1.4.0 adds the optional `env`; `pack-protocol.schema.json` 2.2.0 adds the optional `missingEnv` to `info`. The Python SDK's vendored copies match.
- **`@kindgi/env-schema`:** `KINDGI_PACK_ENV_CHECK` (component `pack-service`).
- **`@kindgi/pack-conformance`:** cases for the declared env, and `unsupported` on a target, which skips the cases for a part of the contract it hasn't implemented yet.
- **The `kindgi-authoring-tools` skill** says to declare the names a tool reads.
