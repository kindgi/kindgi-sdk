---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/compliance": patch
"@kindgi/env-inmemory": patch
"@kindgi/types": patch
---

**An operator can set a pack's env name to a cloud secret.** On a runtime that runs a pack service for each deployment, a name a pack reads from its env can be set, at a tenant's scope and under one env, to a numbered version of a secret the operator's cloud holds, `projects/<project>/secrets/<secret>/versions/<number>`, instead of to a value. The runtime keeps that path and never reads the value: the pack service is given the name, and its cloud reads the value as the pack service's own account. A version is a number, never `latest` or an alias, and a secret whose id starts with `kp-` is refused (`400 cloud-secret-invalid`): those are the pack services' own copies.

Only the operator sets one, with a system key holding the new scope `system:env-refs`: `PUT`, `GET` and `DELETE` on `/v1/system/tenants/{tenantId}/env[/{name}]`, or `kindgi env set NAME --cloud-secret <path> --tenant=<id> --scope=… --env=…`, `kindgi env unset NAME --cloud-secret …` and `kindgi env list --cloud-secret …`. A tenant's own key is refused, on `PUT /v1/env/{name}` with a `cloudSecret` too (`403 cloud-secret-system-only`). A runtime serving one tenant with a pack service per deployment mints `system:env-refs` keys from its own token, for that tenant alone. A runtime with no store for them answers `501 cloud-secrets-unsupported`. Each change is an `env-set` or `env-deleted` audit row naming the system key, marked `cloudSecret`, never with the path. `createInMemoryEnvCloudSecretBinding` is a store for dev and tests, and `parseCloudSecretVersion` checks a path.

The tenant sees which names are set this way, never the path: `GET /v1/env/cloud-secrets` lists them, the pack-env check names each as `kind: "cloud-secret"`, and `kindgi env list --scope` prints it as `NAME (cloud secret)`. The orchestrator's pack-env answer gives each by its path, in `cloudSecrets`, and setting, changing or removing one moves the pack env revision. A name set to a cloud secret and also as a value or a secret is `pack-env-ambiguous`, and its `names` entry carries `cloudSecretScope`. An orchestrator whose host can't give a pack service a cloud secret records `pack-env-cloud-secret-unsupported`. The TypeScript client's `systemEnv` has `setCloudSecret`, `deleteCloudSecret` and `listCloudSecrets`, and `env.listCloudSecrets` is the tenant's list.
