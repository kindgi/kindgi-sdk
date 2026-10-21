# @kindgi/env-inmemory

## 0.1.10-rc.1

### Patch Changes

- @kindgi/api@0.1.10-rc.1
  - @kindgi/audit-events@0.1.10-rc.1
  - @kindgi/compliance@0.1.10-rc.1
  - @kindgi/log@0.1.10-rc.1
  - @kindgi/platform@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- Updated dependencies [2d2ee60]
- Updated dependencies [997470e]
- Updated dependencies [b9a68d5]
- Updated dependencies [6c5006c]
- Updated dependencies [43eafb2]
- Updated dependencies [019a6fd]
- Updated dependencies [d6f844d]
- Updated dependencies [8111046]
- Updated dependencies [01964ed]
- Updated dependencies [05b762e]
- Updated dependencies [25a7309]
- Updated dependencies [c90dd53]
- Updated dependencies [9b6da8a]
  - @kindgi/api@0.1.10-rc.0
  - @kindgi/platform@0.1.10-rc.0
  - @kindgi/compliance@0.1.10-rc.0
  - @kindgi/audit-events@0.1.10-rc.0
  - @kindgi/log@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- 5d68d0d: **An audit record that can't be written, and a check the authorization model can't answer, are logged through your logger instead of the console.**
  - `emitResolveEvent` and `emitLifecycleEvent` (`@kindgi/compliance`) take an optional `log`, a `@kindgi/log` `Logger`. An append that fails or throws still never fails the caller's operation. It's logged there at `warn`, with the record's `tenantId` and `kind`, and the error's `code` or the error it threw. Without a `log` it isn't logged anywhere; before, it went to `console.warn`.
  - `createApp` passes the request's logger, under the subsystem `audit`, for a secret or env write's record and for a secret read refused for its scope. `resolveAtScope` takes that `log` as an optional fourth argument. An app without a `logger` won't see that a record was dropped, and the `logger` option's docs say so.
  - A check the authorization model has no relation for, which is a bug in a route, is logged at `error` through the request's logger, under the subsystem `authz`, with its `action` and `resource`. Before, it went to `console.error`.
  - `createInMemoryEnvBinding` takes an optional `log` and passes it on with every audit record it writes.
- 53b09f7: **`GET /v1/environments` lists the tenant's env names,** for a tenant admin: each name that holds an env value or a secret, at any scope, once, in byte order, paged by `cursor` and `limit`.
  - An env store and a secrets store each say their own names through a new optional `listEnvNames({ tenantId, limit, after })` (`EnvBinding`, `SecretBinding`). A runtime whose store doesn't answers `501 environments-unsupported`, which names the store, rather than a list missing its names.
  - The in-memory env store gives the names its tenant's values are under. The dotenv secrets store gives `local` and each `.env.<name>` file that holds a name.
  - The TypeScript and Python clients list them with `client.environments.list()`.
- 6d3ccdd: **A pack service run per deployment can be given the env its pack declares, from the env store.** On a server that runs a pack service per deployment (it wires `systemDeployments`), the names the pack declares in its index (`env`) are looked up in the env store, at the deployment's project, then the project's org, then the tenant (most specific wins), at the env the server serves. A tenant-wide deployment is read at the tenant's Default project.
  - **Plain values only.** A name set only as a secret can't be given into the pack service's environment yet (`pack-env-secret-not-yet`): a tool reads it per call (`ctx.secrets`). A name set both as a secret and as a plain value is `pack-env-ambiguous`, naming both scopes. A required name set nowhere is `pack-env-missing`. While any of these stands, no value is given, and a running service keeps the values it has.
  - **`GET /v1/deployments/{deploymentId}/pack-env`** shows a tenant where each declared name is set (`project`, `org` or `tenant`) and why it can't be given, if it can't. Never a value. A server whose pack services take their env from how they're run answers `501 pack-env-not-served`. The TypeScript client has `deployments.packEnv`; the Python client, `deployments.pack_env`.
  - **For whatever runs the pack services, on a system key of its own (`system:pack-env`):**
    - `GET /v1/system/pack-env` lists the deployments whose service runs on values that changed;
    - `GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env` gives the values and a `revision`, with each value given out on the audit record (`env-resolved`);
    - `PUT …/pack-env` records the revision the service runs, or that it was held back and why (compare-and-set: `409 pack-env-conflict`). `pack-env-update-failed` holds a revision whose values were given and didn't start: it's listed again for an hour after it was first held, so it's tried again;
    - `PUT …/endpoint` takes `packEnvRevision`, the one a new service was made with.
  
    `system:deployments` reads no value. The TypeScript client has `systemDeployments.listPackEnvChanged`, `getPackEnv` and `recordPackEnv`.
  - **A deployment records its pack's declaration** (`packEnv`, optional), and a deploy whose image index carries a malformed `env` is refused (`image-unverifiable`). A ready endpoint can carry `packEnvProblem` (`{ code, since }`) while its service runs on the values it was last given: one of the three codes above, or `pack-env-update-failed` when the newest values didn't start. `@kindgi/api` exports `packEnvCheck`, `PACK_ENV_PROBLEM_CODES`, `PACK_ENV_HELD_CODES` and `PACK_ENV_RETRY_MS`; `@kindgi/handler-runtime` exports its env declaration check at `@kindgi/handler-runtime/pack-env`.
  - **An env or secret record can carry `recordId`,** the store's own id for its row, never on the wire. The revision carries it, so a removed value set again is a new revision even when its row starts again at 1 in the same millisecond. `@kindgi/env-inmemory` sets it; a store without one has only the update time.
- Updated dependencies [83ad88a]
- Updated dependencies [6ed7bc6]
- Updated dependencies [5d68d0d]
- Updated dependencies [d563887]
- Updated dependencies [499082a]
- Updated dependencies [17bc390]
- Updated dependencies [66e5ec7]
- Updated dependencies [22b619b]
- Updated dependencies [4101430]
- Updated dependencies [d0ee5c5]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [e5b38a8]
- Updated dependencies [c56f757]
- Updated dependencies [1ac8e67]
- Updated dependencies [404c4c9]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [53b09f7]
- Updated dependencies [d563887]
- Updated dependencies [8f52412]
- Updated dependencies [f56c6ae]
- Updated dependencies [c46503d]
- Updated dependencies [7be0273]
- Updated dependencies [e35d94f]
- Updated dependencies [010fd72]
- Updated dependencies [7be42d0]
- Updated dependencies [3b90568]
- Updated dependencies [f605c7e]
- Updated dependencies [d563887]
- Updated dependencies [f82bb04]
- Updated dependencies [d563887]
- Updated dependencies [6d3ccdd]
- Updated dependencies [3c8afcf]
- Updated dependencies [c8d3c1e]
- Updated dependencies [66bb5eb]
- Updated dependencies [d563887]
- Updated dependencies [c1a61c7]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [5b5bd3b]
- Updated dependencies [c44d803]
- Updated dependencies [bd3bcd7]
- Updated dependencies [3be3ba0]
- Updated dependencies [ec3dbf9]
- Updated dependencies [409b9bf]
- Updated dependencies [10ec595]
- Updated dependencies [16bbb17]
- Updated dependencies [d563887]
- Updated dependencies [2a05fac]
- Updated dependencies [cf339d3]
- Updated dependencies [3502389]
- Updated dependencies [dd34dcf]
  - @kindgi/api@0.1.9
  - @kindgi/compliance@0.1.9
  - @kindgi/log@0.1.9
  - @kindgi/platform@0.1.9
  - @kindgi/audit-events@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/api@0.1.9-rc.1
  - @kindgi/audit-events@0.1.9-rc.1
  - @kindgi/compliance@0.1.9-rc.1
  - @kindgi/log@0.1.9-rc.1
  - @kindgi/platform@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- 5d68d0d: **An audit record that can't be written, and a check the authorization model can't answer, are logged through your logger instead of the console.**
  - `emitResolveEvent` and `emitLifecycleEvent` (`@kindgi/compliance`) take an optional `log`, a `@kindgi/log` `Logger`. An append that fails or throws still never fails the caller's operation. It's logged there at `warn`, with the record's `tenantId` and `kind`, and the error's `code` or the error it threw. Without a `log` it isn't logged anywhere; before, it went to `console.warn`.
  - `createApp` passes the request's logger, under the subsystem `audit`, for a secret or env write's record and for a secret read refused for its scope. `resolveAtScope` takes that `log` as an optional fourth argument. An app without a `logger` won't see that a record was dropped, and the `logger` option's docs say so.
  - A check the authorization model has no relation for, which is a bug in a route, is logged at `error` through the request's logger, under the subsystem `authz`, with its `action` and `resource`. Before, it went to `console.error`.
  - `createInMemoryEnvBinding` takes an optional `log` and passes it on with every audit record it writes.
- 53b09f7: **`GET /v1/environments` lists the tenant's env names,** for a tenant admin: each name that holds an env value or a secret, at any scope, once, in byte order, paged by `cursor` and `limit`.
  - An env store and a secrets store each say their own names through a new optional `listEnvNames({ tenantId, limit, after })` (`EnvBinding`, `SecretBinding`). A runtime whose store doesn't answers `501 environments-unsupported`, which names the store, rather than a list missing its names.
  - The in-memory env store gives the names its tenant's values are under. The dotenv secrets store gives `local` and each `.env.<name>` file that holds a name.
  - The TypeScript and Python clients list them with `client.environments.list()`.
- 6d3ccdd: **A pack service run per deployment can be given the env its pack declares, from the env store.** On a server that runs a pack service per deployment (it wires `systemDeployments`), the names the pack declares in its index (`env`) are looked up in the env store, at the deployment's project, then the project's org, then the tenant (most specific wins), at the env the server serves. A tenant-wide deployment is read at the tenant's Default project.
  - **Plain values only.** A name set only as a secret can't be given into the pack service's environment yet (`pack-env-secret-not-yet`): a tool reads it per call (`ctx.secrets`). A name set both as a secret and as a plain value is `pack-env-ambiguous`, naming both scopes. A required name set nowhere is `pack-env-missing`. While any of these stands, no value is given, and a running service keeps the values it has.
  - **`GET /v1/deployments/{deploymentId}/pack-env`** shows a tenant where each declared name is set (`project`, `org` or `tenant`) and why it can't be given, if it can't. Never a value. A server whose pack services take their env from how they're run answers `501 pack-env-not-served`. The TypeScript client has `deployments.packEnv`; the Python client, `deployments.pack_env`.
  - **For whatever runs the pack services, on a system key of its own (`system:pack-env`):**
    - `GET /v1/system/pack-env` lists the deployments whose service runs on values that changed;
    - `GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env` gives the values and a `revision`, with each value given out on the audit record (`env-resolved`);
    - `PUT …/pack-env` records the revision the service runs, or that it was held back and why (compare-and-set: `409 pack-env-conflict`). `pack-env-update-failed` holds a revision whose values were given and didn't start: it's listed again for an hour after it was first held, so it's tried again;
    - `PUT …/endpoint` takes `packEnvRevision`, the one a new service was made with.
  
    `system:deployments` reads no value. The TypeScript client has `systemDeployments.listPackEnvChanged`, `getPackEnv` and `recordPackEnv`.
  - **A deployment records its pack's declaration** (`packEnv`, optional), and a deploy whose image index carries a malformed `env` is refused (`image-unverifiable`). A ready endpoint can carry `packEnvProblem` (`{ code, since }`) while its service runs on the values it was last given: one of the three codes above, or `pack-env-update-failed` when the newest values didn't start. `@kindgi/api` exports `packEnvCheck`, `PACK_ENV_PROBLEM_CODES`, `PACK_ENV_HELD_CODES` and `PACK_ENV_RETRY_MS`; `@kindgi/handler-runtime` exports its env declaration check at `@kindgi/handler-runtime/pack-env`.
  - **An env or secret record can carry `recordId`,** the store's own id for its row, never on the wire. The revision carries it, so a removed value set again is a new revision even when its row starts again at 1 in the same millisecond. `@kindgi/env-inmemory` sets it; a store without one has only the update time.
- Updated dependencies [83ad88a]
- Updated dependencies [6ed7bc6]
- Updated dependencies [5d68d0d]
- Updated dependencies [d563887]
- Updated dependencies [499082a]
- Updated dependencies [17bc390]
- Updated dependencies [66e5ec7]
- Updated dependencies [22b619b]
- Updated dependencies [4101430]
- Updated dependencies [d0ee5c5]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [e5b38a8]
- Updated dependencies [c56f757]
- Updated dependencies [1ac8e67]
- Updated dependencies [404c4c9]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [53b09f7]
- Updated dependencies [d563887]
- Updated dependencies [8f52412]
- Updated dependencies [f56c6ae]
- Updated dependencies [c46503d]
- Updated dependencies [7be0273]
- Updated dependencies [e35d94f]
- Updated dependencies [010fd72]
- Updated dependencies [7be42d0]
- Updated dependencies [3b90568]
- Updated dependencies [f605c7e]
- Updated dependencies [d563887]
- Updated dependencies [f82bb04]
- Updated dependencies [d563887]
- Updated dependencies [6d3ccdd]
- Updated dependencies [3c8afcf]
- Updated dependencies [c8d3c1e]
- Updated dependencies [66bb5eb]
- Updated dependencies [d563887]
- Updated dependencies [c1a61c7]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [5b5bd3b]
- Updated dependencies [c44d803]
- Updated dependencies [bd3bcd7]
- Updated dependencies [3be3ba0]
- Updated dependencies [ec3dbf9]
- Updated dependencies [409b9bf]
- Updated dependencies [10ec595]
- Updated dependencies [16bbb17]
- Updated dependencies [d563887]
- Updated dependencies [2a05fac]
- Updated dependencies [cf339d3]
- Updated dependencies [3502389]
- Updated dependencies [dd34dcf]
  - @kindgi/api@0.1.9-rc.0
  - @kindgi/compliance@0.1.9-rc.0
  - @kindgi/log@0.1.9-rc.0
  - @kindgi/platform@0.1.9-rc.0
  - @kindgi/audit-events@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [fddc8f7]
- Updated dependencies [3a3f233]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ba8d9a1]
- Updated dependencies [ebf405d]
- Updated dependencies [059c2c2]
- Updated dependencies [3a3f233]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [b22e616]
- Updated dependencies [ebf405d]
- Updated dependencies [cfe5422]
- Updated dependencies [70b85f8]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [3a3f233]
- Updated dependencies [1c8b391]
- Updated dependencies [08bf3e5]
- Updated dependencies [6329f93]
- Updated dependencies [ebf405d]
- Updated dependencies [9ba9e5f]
- Updated dependencies [ebf405d]
- Updated dependencies [14d02c5]
- Updated dependencies [d985473]
- Updated dependencies [718e635]
- Updated dependencies [036605f]
- Updated dependencies [fddc8f7]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [9f4340c]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [a2ee44b]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [f05d320]
- Updated dependencies [1bd39aa]
  - @kindgi/api@0.1.8
  - @kindgi/platform@0.1.8
  - @kindgi/types@0.1.8
  - @kindgi/compliance@0.1.8
  - @kindgi/audit-events@0.1.8

## 0.1.8-rc.0

### Patch Changes

- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [fddc8f7]
- Updated dependencies [3a3f233]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ba8d9a1]
- Updated dependencies [ebf405d]
- Updated dependencies [059c2c2]
- Updated dependencies [3a3f233]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [b22e616]
- Updated dependencies [ebf405d]
- Updated dependencies [cfe5422]
- Updated dependencies [70b85f8]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [3a3f233]
- Updated dependencies [1c8b391]
- Updated dependencies [08bf3e5]
- Updated dependencies [6329f93]
- Updated dependencies [ebf405d]
- Updated dependencies [9ba9e5f]
- Updated dependencies [ebf405d]
- Updated dependencies [14d02c5]
- Updated dependencies [d985473]
- Updated dependencies [718e635]
- Updated dependencies [036605f]
- Updated dependencies [fddc8f7]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [9f4340c]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [a2ee44b]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [f05d320]
- Updated dependencies [1bd39aa]
  - @kindgi/api@0.1.8-rc.0
  - @kindgi/platform@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0
  - @kindgi/compliance@0.1.8-rc.0
  - @kindgi/audit-events@0.1.8-rc.0

## 0.1.7

### Patch Changes

- Updated dependencies [b90e2c6]
- Updated dependencies [a134048]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
- Updated dependencies [ae6d594]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
  - @kindgi/audit-events@0.1.7
  - @kindgi/api@0.1.7
  - @kindgi/types@0.1.7
  - @kindgi/compliance@0.1.7
  - @kindgi/platform@0.1.7

## 0.1.7-rc.0

### Patch Changes

- Updated dependencies [b90e2c6]
- Updated dependencies [a134048]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
- Updated dependencies [ae6d594]
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
  - @kindgi/audit-events@0.1.7-rc.0
  - @kindgi/api@0.1.7-rc.0
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/compliance@0.1.7-rc.0
  - @kindgi/platform@0.1.7-rc.0

## 0.1.6

### Patch Changes

- Updated dependencies [70c8d1f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [fd93b3e]
- Updated dependencies [a6ac2e9]
- Updated dependencies [fdb86ae]
- Updated dependencies [de726fe]
- Updated dependencies [fdb86ae]
- Updated dependencies [eed55a1]
- Updated dependencies [874567d]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [b8cd054]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [bef2d8c]
- Updated dependencies [fdb86ae]
- Updated dependencies [85ef97c]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [f0d6a12]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [5f460dd]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [6a4715c]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [b4bbd95]
- Updated dependencies [01958d4]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [f49efa3]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [929db86]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
  - @kindgi/api@0.1.6
  - @kindgi/compliance@0.1.6
  - @kindgi/types@0.1.6
  - @kindgi/platform@0.1.6
  - @kindgi/audit-events@0.1.6

## 0.1.6-rc.0

### Patch Changes

- Updated dependencies [70c8d1f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [fd93b3e]
- Updated dependencies [a6ac2e9]
- Updated dependencies [fdb86ae]
- Updated dependencies [de726fe]
- Updated dependencies [fdb86ae]
- Updated dependencies [eed55a1]
- Updated dependencies [874567d]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [b8cd054]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [bef2d8c]
- Updated dependencies [fdb86ae]
- Updated dependencies [85ef97c]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [f0d6a12]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [5f460dd]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [6a4715c]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [b4bbd95]
- Updated dependencies [01958d4]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [f49efa3]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [929db86]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
  - @kindgi/api@0.1.6-rc.0
  - @kindgi/compliance@0.1.6-rc.0
  - @kindgi/types@0.1.6-rc.0
  - @kindgi/platform@0.1.6-rc.0
  - @kindgi/audit-events@0.1.6-rc.0

## 0.1.5

### Patch Changes

- Updated dependencies [da52d80]
- Updated dependencies [7e5d65d]
- Updated dependencies [6f7545b]
- Updated dependencies [0919fe6]
- Updated dependencies [9801f25]
- Updated dependencies [490d083]
- Updated dependencies [cb20b9a]
- Updated dependencies [f19bc64]
- Updated dependencies [ede39f3]
- Updated dependencies [93ea565]
- Updated dependencies [a211c34]
- Updated dependencies [37734c5]
- Updated dependencies [3fbb4ee]
- Updated dependencies [b67c599]
- Updated dependencies [e27d050]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [1633db1]
- Updated dependencies [b67c599]
- Updated dependencies [93ebe85]
- Updated dependencies [b67c599]
- Updated dependencies [d94a98c]
- Updated dependencies [88953c7]
- Updated dependencies [fa77071]
- Updated dependencies [704dd29]
- Updated dependencies [70c5737]
- Updated dependencies [b67c599]
- Updated dependencies [eff6249]
- Updated dependencies [0fe157e]
- Updated dependencies [18576cf]
- Updated dependencies [70c5737]
- Updated dependencies [81f46aa]
- Updated dependencies [e99a7aa]
- Updated dependencies [a1f3dd1]
- Updated dependencies [d25c1b3]
- Updated dependencies [1a1f5ca]
- Updated dependencies [d7d5c45]
- Updated dependencies [94c999f]
- Updated dependencies [2799295]
- Updated dependencies [976801d]
- Updated dependencies [966425e]
- Updated dependencies [646a906]
- Updated dependencies [cbb6785]
- Updated dependencies [66bab49]
- Updated dependencies [6dc2637]
- Updated dependencies [e34e3bc]
- Updated dependencies [b67c599]
- Updated dependencies [7a85bf6]
- Updated dependencies [423aeea]
  - @kindgi/api@0.1.5
  - @kindgi/compliance@0.1.5
  - @kindgi/types@0.1.5
  - @kindgi/audit-events@0.1.5
  - @kindgi/platform@0.1.5

## 0.1.5-rc.0

### Patch Changes

- Updated dependencies [0919fe6]
- Updated dependencies [9801f25]
- Updated dependencies [490d083]
- Updated dependencies [cb20b9a]
- Updated dependencies [f19bc64]
- Updated dependencies [ede39f3]
- Updated dependencies [93ea565]
- Updated dependencies [a211c34]
- Updated dependencies [37734c5]
- Updated dependencies [3fbb4ee]
- Updated dependencies [b67c599]
- Updated dependencies [e27d050]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [1633db1]
- Updated dependencies [b67c599]
- Updated dependencies [93ebe85]
- Updated dependencies [b67c599]
- Updated dependencies [d94a98c]
- Updated dependencies [88953c7]
- Updated dependencies [fa77071]
- Updated dependencies [704dd29]
- Updated dependencies [70c5737]
- Updated dependencies [b67c599]
- Updated dependencies [eff6249]
- Updated dependencies [0fe157e]
- Updated dependencies [18576cf]
- Updated dependencies [70c5737]
- Updated dependencies [81f46aa]
- Updated dependencies [e99a7aa]
- Updated dependencies [a1f3dd1]
- Updated dependencies [d25c1b3]
- Updated dependencies [1a1f5ca]
- Updated dependencies [d7d5c45]
- Updated dependencies [94c999f]
- Updated dependencies [2799295]
- Updated dependencies [976801d]
- Updated dependencies [966425e]
- Updated dependencies [646a906]
- Updated dependencies [cbb6785]
- Updated dependencies [66bab49]
- Updated dependencies [6dc2637]
- Updated dependencies [e34e3bc]
- Updated dependencies [b67c599]
- Updated dependencies [7a85bf6]
- Updated dependencies [423aeea]
  - @kindgi/api@0.1.5-rc.0
  - @kindgi/compliance@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0
  - @kindgi/audit-events@0.1.5-rc.0
  - @kindgi/platform@0.1.5-rc.0

## 0.1.4

### Patch Changes

- Updated dependencies [1c0252c]
- Updated dependencies [1c0252c]
- Updated dependencies [b9d3c01]
- Updated dependencies [ee0b6d5]
- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [0b1f48d]
- Updated dependencies [2b34f78]
- Updated dependencies [9a7f43b]
- Updated dependencies [6260a59]
- Updated dependencies [0359caf]
- Updated dependencies [29fbd56]
- Updated dependencies [fcc6a97]
- Updated dependencies [d0ebeb6]
- Updated dependencies [149a8c9]
- Updated dependencies [86ec2ef]
- Updated dependencies [e97958c]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [e2ab2ac]
- Updated dependencies [fac7472]
- Updated dependencies [52c8f98]
- Updated dependencies [bd3ce67]
- Updated dependencies [d3dffb5]
- Updated dependencies [7528aca]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [b8ff156]
- Updated dependencies [e58e35c]
- Updated dependencies [5608264]
- Updated dependencies [7a8e764]
- Updated dependencies [8491dd8]
- Updated dependencies [a0921a1]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [ba2f212]
- Updated dependencies [06b5fc0]
- Updated dependencies [e17b230]
- Updated dependencies [e7e2f86]
- Updated dependencies [3d23304]
- Updated dependencies [42a2e66]
- Updated dependencies [7155588]
- Updated dependencies [2923703]
- Updated dependencies [7471e05]
- Updated dependencies [bfeabfd]
- Updated dependencies [8861bf8]
- Updated dependencies [d0ebeb6]
- Updated dependencies [9801f64]
- Updated dependencies [dc5cfb1]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [62608e3]
- Updated dependencies [3e427c5]
- Updated dependencies [f90c285]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/api@0.1.4
  - @kindgi/audit-events@0.1.4
  - @kindgi/types@0.1.4
  - @kindgi/compliance@0.1.4
  - @kindgi/platform@0.1.4

## 0.1.4-rc.5

### Patch Changes

- Updated dependencies [29fbd56]
- Updated dependencies [52c8f98]
- Updated dependencies [9801f64]
  - @kindgi/api@0.1.4-rc.5
  - @kindgi/compliance@0.1.4-rc.5
  - @kindgi/audit-events@0.1.4-rc.5
  - @kindgi/platform@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- Updated dependencies [5608264]
  - @kindgi/api@0.1.4-rc.4
  - @kindgi/audit-events@0.1.4-rc.4
  - @kindgi/compliance@0.1.4-rc.4
  - @kindgi/platform@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- Updated dependencies [3e427c5]
  - @kindgi/api@0.1.4-rc.3
  - @kindgi/audit-events@0.1.4-rc.3
  - @kindgi/compliance@0.1.4-rc.3
  - @kindgi/platform@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [0b1f48d]
- Updated dependencies [2b34f78]
- Updated dependencies [9a7f43b]
- Updated dependencies [fcc6a97]
- Updated dependencies [149a8c9]
- Updated dependencies [86ec2ef]
- Updated dependencies [e97958c]
- Updated dependencies [e2ab2ac]
- Updated dependencies [bd3ce67]
- Updated dependencies [7528aca]
- Updated dependencies [e58e35c]
- Updated dependencies [8491dd8]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [ba2f212]
- Updated dependencies [e7e2f86]
- Updated dependencies [42a2e66]
- Updated dependencies [7155588]
- Updated dependencies [7471e05]
- Updated dependencies [dc5cfb1]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/api@0.1.4-rc.2
  - @kindgi/audit-events@0.1.4-rc.2
  - @kindgi/compliance@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [0359caf]
- Updated dependencies [b8ff156]
- Updated dependencies [06b5fc0]
- Updated dependencies [8861bf8]
- Updated dependencies [f90c285]
  - @kindgi/api@0.1.4-rc.1
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/compliance@0.1.4-rc.1
  - @kindgi/audit-events@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [6260a59]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [7a8e764]
- Updated dependencies [a0921a1]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
- Updated dependencies [e17b230]
- Updated dependencies [3d23304]
- Updated dependencies [2923703]
- Updated dependencies [bfeabfd]
- Updated dependencies [d0ebeb6]
- Updated dependencies [62608e3]
  - @kindgi/api@0.1.4-rc.0
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0
  - @kindgi/compliance@0.1.4-rc.0
  - @kindgi/audit-events@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [2544717]
- Updated dependencies [0f226c2]
- Updated dependencies [629057d]
- Updated dependencies [1463b77]
- Updated dependencies [453056f]
- Updated dependencies [6bae409]
- Updated dependencies [ab23a9b]
- Updated dependencies [6c274dd]
- Updated dependencies [2c185d8]
  - @kindgi/api@0.1.3
  - @kindgi/types@0.1.3
  - @kindgi/audit-events@0.1.3
  - @kindgi/compliance@0.1.3
  - @kindgi/platform@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
- Updated dependencies [610a9de]
  - @kindgi/api@0.1.2
  - @kindgi/audit-events@0.1.2
  - @kindgi/compliance@0.1.2
  - @kindgi/platform@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [786ea98]
- Updated dependencies [324aba4]
  - @kindgi/api@0.1.1
  - @kindgi/audit-events@0.1.1
  - @kindgi/compliance@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/api@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/audit-events@0.1.0
  - @kindgi/compliance@0.1.0
  - @kindgi/platform@0.1.0
