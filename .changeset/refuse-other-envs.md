---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/env-schema": patch
"@kindgi/sdk": patch
---

**A runtime that keeps its values under one env refuses a value it would never read.** Kindgi Cloud's runtime serves one env, `prod`, and reads every value under it, so a secret set under `staging` was stored and never read. A runtime can now refuse such values: `createApp({ envName, refuseOtherEnvs: true })` (`KINDGI_REFUSE_OTHER_ENVS=true` on the server, with `KINDGI_ENV`). Off by default; a runtime that leaves it off takes any env, as before.
- **What it refuses, with `409 env-not-served`:**
  - a secret set or rotated, or an env value put, under another env (`POST /v1/secrets`, `POST /v1/secrets/{name}/rotate`, `PUT /v1/env/{name}`), and a deployment's secret sync under another env (`POST /v1/deployments/{deploymentId}/secrets`), before anything is written;
  - a model provider, MCP endpoint or webhook endpoint created or changed with its secret named under another env.
- **The error** names the env the runtime serves and what to do (`details: { envName, servedEnv }`).
- **What it still takes:**
  - reads and deletes under any env, so a value stored before can be found and removed;
  - a secret at the tenant's scope that a registration made before names under its own env, so a value in use can still be rotated.
- **whoami says what's served:** `GET /v1/identity/whoami` answers `servedEnv: { envName, refusesOtherEnvs }` when the runtime serves an env. The field is optional, and absent on a runtime that serves none.
- **The CLI follows it.** On a runtime that refuses other envs:
  - `--env` defaults to the served env for `kindgi secrets`, `kindgi env` with `--scope`, `kindgi env pull` and `kindgi providers register --preset`;
  - a write under another env is refused before anything is sent, and so is `kindgi deploy --sync-secrets`, before the build;
  - elsewhere every default stays as it was.
- **The MCP servers skill** says where a `--env=local` secret goes when the CLI is signed in to Kindgi Cloud.
