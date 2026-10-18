---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/handler-runtime": patch
---

**A pack service run per deployment can be given the env its pack declares, from the env store.** On a server that runs a pack service per deployment (it wires `systemDeployments`), the names the pack declares in its index (`env`) are looked up in the env store, at the deployment's project, then the project's org, then the tenant (most specific wins), at the env the server serves. A tenant-wide deployment is read at the tenant's Default project.
- **Plain values only.** A name set only as a secret can't be given into the pack service's environment yet (`pack-env-secret-not-yet`): a tool reads it per call (`ctx.secrets`). A name set both as a secret and as a plain value is `pack-env-ambiguous`, naming both scopes. A required name set nowhere is `pack-env-missing`. While any of these stands, no value is given, and a running service keeps the values it has.
- **`GET /v1/deployments/{deploymentId}/pack-env`** shows a tenant where each declared name is set (`project`, `org` or `tenant`) and why it can't be given, if it can't. Never a value. A server whose pack services take their env from how they're run answers `501 pack-env-not-served`. The TypeScript client has `deployments.packEnv`; the Python client, `deployments.pack_env`.
- **For whatever runs the pack services, on a system key of its own (`system:pack-env`):**
  - `GET /v1/system/pack-env` lists the deployments whose service runs on values that changed;
  - `GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env` gives the values and a `revision`, with each value given out on the audit record (`env-resolved`);
  - `PUT …/pack-env` records the revision the service runs, or that it was held back and why (compare-and-set: `409 pack-env-conflict`). `pack-env-update-failed` holds a revision whose values were given and didn't start: it's listed again for an hour after it was first held, so it's tried again;
  - `PUT …/endpoint` takes `packEnvRevision`, the one a new service was made with.
  
  `system:deployments` reads no value. The TypeScript client has `systemDeployments.listPackEnvChanged`, `getPackEnv` and `recordPackEnv`.
- **A deployment records its pack's declaration** (`packEnv`, optional), and a deploy whose image index carries a malformed `env` is refused (`image-unverifiable`). A ready endpoint can carry `packEnvProblem` (`{ code, since }`) while its service runs on the values it was last given: one of the three codes above, or `pack-env-update-failed` when the newest values didn't start. `@kindgi/api` exports `packEnvCheck`, `PACK_ENV_PROBLEM_CODES`, `PACK_ENV_HELD_CODES` and `PACK_ENV_RETRY_MS`; `@kindgi/handler-runtime` exports its env declaration check at `@kindgi/handler-runtime/pack-env`.
