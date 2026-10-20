---
"@kindgi/types": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A stdio MCP server's secret goes by reference, never in plaintext `config.env`** (runtime 0.1.12 or later).
- **New field, `secretEnv`:** a stdio endpoint's secret variables, each name with the secret its value is read from when the runtime starts the server. The value is never stored with the endpoint or answered:
  ```json
  "secretEnv": { "GITHUB_TOKEN": { "envName": "production", "name": "FILES_GITHUB_TOKEN" } }
  ```
  It takes 1 to 16 variables. Each name has no `=` or NUL, and none is also in `config.env` (`secret-env-twice`); otherwise the reason is `invalid-secret-env`. It's `stdio` only: on an HTTP endpoint it's refused (`secret-env-on-http`). Each secret is read at the endpoint's recorded scope, and counts for the provider-key guard and for the env a runtime serves, as `secretRef`'s does.
- **A credential in `config.env` is refused at registration** (`invalid-mcp-endpoint`, reason `credential-in-env`). The message names the variable, never its value, and shows the `secretEnv` that replaces it.
  - **Which names count:** the ones `config.headers` refuses, with parts split on `_` as well as `-`: `GITHUB_TOKEN`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `SLACK_BOT_TOKEN`, `DB_PASSWORD`. A lone `KEY` doesn't count: `CACHE_KEY` stays plain.
  - **Exported:** the rule is `isCredentialEnvName()`.
- **Every `config.env` value reads back as `"[redacted]"`**, its name kept, from `GET /v1/mcp/endpoints[/:id]`, on endpoints registered before too. A secret can sit under a name the rule doesn't catch (`DATABASE_URL`, `PGPASSWORD`), and the runtime reads the stored endpoint, never this answer. So a stdio endpoint's export holds env names, not values. A value of exactly `[redacted]` is refused at registration (`invalid-stdio-env`), so a copy of a `GET` answer can't register it by mistake.
- **`secretRef` on a `stdio` endpoint is refused** (`secret-ref-on-stdio`): it's sent as a bearer header, and a stdio server gets no headers. Use `secretEnv`.
- **What a process's environment can't carry is refused** (`invalid-stdio-env`): an empty `config.env` name, `=` or a NUL in a name, a NUL in a value. The message names the variable, never the value.
- **Endpoints registered before keep working.** `kindgi doctor` has a new check, MCP endpoint env (`mcp-env`). It lists each stdio endpoint on the runtime the CLI points at that keeps a credential-named variable in `config.env`, or a `secretRef`, with the fix. It's a warning: the endpoint still works.
- **If you roll back** to a runtime older than 0.1.12, an endpoint registered with `secretEnv` before the rollback starts without those variables. The server fails its own calls, and no value is exposed. Registering one with `secretEnv` there is refused (`invalid-mcp-endpoint`, reason `unknown-field`): that runtime doesn't know the field.
- **New exports:**
  - `@kindgi/types`: `isCredentialName()`, the rule both `isCredentialHeaderName()` and `isCredentialEnvName()` apply;
  - `@kindgi/api`: `isCredentialEnvName()`, `MCP_SECRET_ENV_MAX` and `REDACTED_ENV_VALUE`;
  - `@kindgi/client`: `secretEnv` on `McpEndpoint` and `RegisterMcpEndpointInput`. The Python client's models carry it too.
