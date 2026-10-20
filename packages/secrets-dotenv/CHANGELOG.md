# @kindgi/secrets-dotenv

## 0.1.9-rc.1

### Patch Changes

- @kindgi/api@0.1.9-rc.1
  - @kindgi/dotenv-file@0.1.9-rc.1
  - @kindgi/platform@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- 53b09f7: **`GET /v1/environments` lists the tenant's env names,** for a tenant admin: each name that holds an env value or a secret, at any scope, once, in byte order, paged by `cursor` and `limit`.
  - An env store and a secrets store each say their own names through a new optional `listEnvNames({ tenantId, limit, after })` (`EnvBinding`, `SecretBinding`). A runtime whose store doesn't answers `501 environments-unsupported`, which names the store, rather than a list missing its names.
  - The in-memory env store gives the names its tenant's values are under. The dotenv secrets store gives `local` and each `.env.<name>` file that holds a name.
  - The TypeScript and Python clients list them with `client.environments.list()`.
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
  - @kindgi/platform@0.1.9-rc.0
  - @kindgi/dotenv-file@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- ba8d9a1: **A secret name the store can't write is the caller's `400`, saying the store's rule, never a `500`.**
  - **Under `kindgi dev`,** a secret is a key in your env files, so a name Kindgi writes is capital letters, digits and underscores, not starting with a digit.
    - Any other name (`acme-woo-orders`) is refused with `400 secret-name-invalid`, and when one can be made from it, the message offers a name that works (`ACME_WOO_ORDERS`). So is a `KINDGI_*` name.
    - A `kindgi.` name is refused with `400 reserved-name-prefix`.
    - These used to answer `500 secret-store-error`.
    - This applies to `POST /v1/secrets`, `PATCH /v1/tenant/config` and `POST /v1/webhooks` with `generateSecret`.
  - **`POST /v1/webhooks` with `generateSecret` refuses such a name before anything is stored.** No trigger is registered and then taken back.
  - **A name typed into `.env` by hand still resolves,** even one Kindgi wouldn't write (`acme-woo-orders=…`). A webhook trigger may still name it, and `PATCH /v1/webhooks/{triggerId}` may switch to it.
  - **`PATCH /v1/tenant/config` answers a refused secret write at its code's status,** as `POST /v1/secrets` does. That's a `400` for a secret the store refuses for its name or its size, or a `429`, `502` or `503` when the store's external provider limits the runtime's requests, refuses its credentials or can't be reached. It answered `500` for every code.
  - **The API reference lists those `429`, `502` and `503` answers** for both operations.
  - **`SecretBinding.nameRefusal(name)` is a new optional method.** It's how a store says which names it can't write, and `set` refuses those names with the same code. `observeSecretWrites` and `guardProviderKeys` pass it through.
  - **`kindgi webhooks register --secret` now says the rule that applies under `kindgi dev`.**
- ebf405d: **Where a secret an item names is read is decided when the item is registered, and recorded on it.**
  - **Which items:** an MCP endpoint (`secretRef`, `auth.secretRef`), a tool (a spec tool's `secretRef`, the secrets a pack tool declares; through `POST /v1/tools` or a deployment), and a webhook trigger's signing secret.
  - **How it's decided:** the secret is looked for at the item's own scope, then its project's org, then the tenant, at the scopes the person registering it administers. The first that has it is recorded. If none has it yet, the broadest scope they administer is: the tenant for a tenant admin, the project for a project admin. Nothing is refused for it.
  - **What's recorded:** `secretScopes` (by name) on an MCP endpoint and a tool version, `hmacSecretScope` on a webhook trigger. They're the server's, never a caller's. The runtime reads the secret there only. A secret removed from that scope is missing, never read from a broader one, and one set later at another scope changes nothing until it's recorded again: a tool by publishing a new version, an MCP endpoint by unregistering it and registering it again, a webhook trigger by an update that names its secret.
  - **Webhook triggers:** the receiver reads the signing secret at `hmacSecretScope`; a trigger registered before it was recorded reads the tenant's, as before.
  - **`generateSecret`:** `POST /v1/webhooks` can make the signing secret itself, in the trigger's project, needing only `write` there; the answer carries it once (`signingSecret`). A name the project already has is refused (`409 secret-write-conflict`). `kindgi webhooks register --generate-secret` now uses it, in one call, and no longer takes `--env`.
  - **Read there only:** `SecretResolveInput.exact` reads at the given scope with no walk to a broader one, and every secrets store must honour it. `SecretResolveOutcome.scope` says where a value was read. `resolveAtScope` reads an item's secret at its recorded scope with `exact`. A value a store reads at another scope anyway, or without saying which, is refused as not set, and the refusal is audited (`secret-resolved`, failed, `secret-scope-mismatch`) without the value. A custom store must honour `exact` and report the scope it read. The dotenv store keeps one set of values for every scope, so it reports the scope it was asked at.
  - **`emitResolveEvent`** (`@kindgi/compliance`): `projectId` is optional, for a read at the tenant or an org.
  - **`CreateAppInput.envName`:** the env this deployment serves, where the secrets a tool's code declares are looked for.
  - **`RecordedSecretScope`** (`@kindgi/types`): the recorded scope's shape.
- 14d02c5: **A secret value the store can't hold is the caller's `400`, saying why, never a `500`.**
  - **Under `kindgi dev`,** a secret is a key in your env files. No env-file quoting holds a value that has a double quote, or a backslash followed by `n` or `r`, together with a carriage return or with both a single quote and a backtick.
    - Such a value is refused with `400 secret-value-invalid`, the new code, before any file is read. It used to answer `500 secret-store-error`.
    - The message says why and never repeats the value.
    - This applies to `POST /v1/secrets`, `PATCH /v1/tenant/config` and `POST /v1/deployments/{deploymentId}/secrets`.
  - **`SecretError` gains the codes a store's `set` refuses with:** `reserved-name-prefix`, `secret-name-invalid`, `secret-value-too-large` and `secret-value-invalid`. A store that rotates by setting a new version can answer a rotation's new value as it answers the write, and `POST /v1/secrets/{name}/rotate` answers any of them it gets at `400`.
  - **The API reference:**
    - lists `secret-value-invalid` beside the other refusals for those three operations;
    - gives `POST /v1/secrets/{name}/rotate` its `400` (`secret-value-too-large`, `reserved-name-prefix`);
    - lists the `429`, `502` and `503` an external provider answers for the rotation and the deployment sync, as it already did for the other two.
- d985473: **`GET /v1/secrets` reads `includeRevoked`, and the `kindgi dev` secrets store pages.**
  - `?includeRevoked=true` lists revoked secrets too, with `revokedAt` and `revokeReason`. It's metadata only, never a value. The route used to drop it, so `kindgi secrets list --include-revoked` and the TypeScript client's `secrets.list({ includeRevoked })` did nothing; now they reach the store. The operation documents the parameter, and the Python client's `secrets.list` gains `include_revoked`.
  - `SecretBinding.list`'s contract says what a store returns: name order, at most `limit` records, and a `nextCursor` while more remain. `listVersions`' says the same, oldest first.
  - `GET /v1/secrets` and `GET /v1/secrets/{name}/versions` answer `400 bad-input` to a `cursor` the store didn't issue, as the agents, flows, policies and eval-suites version lists do, so a client paging until done is never sent back to the first page. A store says which cursors it issued with `SecretBinding.issuedCursor` (optional: a store without it gets any cursor, as before); `@kindgi/secrets-dotenv` has it.
  - `@kindgi/secrets-dotenv` pages by name: a `nextCursor` while more remain, and the next page starts after the page's last name, so a name added between pages neither repeats nor skips another. Before, it stopped at `limit`, and a 26th secret was out of reach.
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
  - @kindgi/dotenv-file@0.1.8

## 0.1.8-rc.0

### Patch Changes

- ba8d9a1: **A secret name the store can't write is the caller's `400`, saying the store's rule, never a `500`.**
  - **Under `kindgi dev`,** a secret is a key in your env files, so a name Kindgi writes is capital letters, digits and underscores, not starting with a digit.
    - Any other name (`acme-woo-orders`) is refused with `400 secret-name-invalid`, and when one can be made from it, the message offers a name that works (`ACME_WOO_ORDERS`). So is a `KINDGI_*` name.
    - A `kindgi.` name is refused with `400 reserved-name-prefix`.
    - These used to answer `500 secret-store-error`.
    - This applies to `POST /v1/secrets`, `PATCH /v1/tenant/config` and `POST /v1/webhooks` with `generateSecret`.
  - **`POST /v1/webhooks` with `generateSecret` refuses such a name before anything is stored.** No trigger is registered and then taken back.
  - **A name typed into `.env` by hand still resolves,** even one Kindgi wouldn't write (`acme-woo-orders=…`). A webhook trigger may still name it, and `PATCH /v1/webhooks/{triggerId}` may switch to it.
  - **`PATCH /v1/tenant/config` answers a refused secret write at its code's status,** as `POST /v1/secrets` does. That's a `400` for a secret the store refuses for its name or its size, or a `429`, `502` or `503` when the store's external provider limits the runtime's requests, refuses its credentials or can't be reached. It answered `500` for every code.
  - **The API reference lists those `429`, `502` and `503` answers** for both operations.
  - **`SecretBinding.nameRefusal(name)` is a new optional method.** It's how a store says which names it can't write, and `set` refuses those names with the same code. `observeSecretWrites` and `guardProviderKeys` pass it through.
  - **`kindgi webhooks register --secret` now says the rule that applies under `kindgi dev`.**
- ebf405d: **Where a secret an item names is read is decided when the item is registered, and recorded on it.**
  - **Which items:** an MCP endpoint (`secretRef`, `auth.secretRef`), a tool (a spec tool's `secretRef`, the secrets a pack tool declares; through `POST /v1/tools` or a deployment), and a webhook trigger's signing secret.
  - **How it's decided:** the secret is looked for at the item's own scope, then its project's org, then the tenant, at the scopes the person registering it administers. The first that has it is recorded. If none has it yet, the broadest scope they administer is: the tenant for a tenant admin, the project for a project admin. Nothing is refused for it.
  - **What's recorded:** `secretScopes` (by name) on an MCP endpoint and a tool version, `hmacSecretScope` on a webhook trigger. They're the server's, never a caller's. The runtime reads the secret there only. A secret removed from that scope is missing, never read from a broader one, and one set later at another scope changes nothing until it's recorded again: a tool by publishing a new version, an MCP endpoint by unregistering it and registering it again, a webhook trigger by an update that names its secret.
  - **Webhook triggers:** the receiver reads the signing secret at `hmacSecretScope`; a trigger registered before it was recorded reads the tenant's, as before.
  - **`generateSecret`:** `POST /v1/webhooks` can make the signing secret itself, in the trigger's project, needing only `write` there; the answer carries it once (`signingSecret`). A name the project already has is refused (`409 secret-write-conflict`). `kindgi webhooks register --generate-secret` now uses it, in one call, and no longer takes `--env`.
  - **Read there only:** `SecretResolveInput.exact` reads at the given scope with no walk to a broader one, and every secrets store must honour it. `SecretResolveOutcome.scope` says where a value was read. `resolveAtScope` reads an item's secret at its recorded scope with `exact`. A value a store reads at another scope anyway, or without saying which, is refused as not set, and the refusal is audited (`secret-resolved`, failed, `secret-scope-mismatch`) without the value. A custom store must honour `exact` and report the scope it read. The dotenv store keeps one set of values for every scope, so it reports the scope it was asked at.
  - **`emitResolveEvent`** (`@kindgi/compliance`): `projectId` is optional, for a read at the tenant or an org.
  - **`CreateAppInput.envName`:** the env this deployment serves, where the secrets a tool's code declares are looked for.
  - **`RecordedSecretScope`** (`@kindgi/types`): the recorded scope's shape.
- 14d02c5: **A secret value the store can't hold is the caller's `400`, saying why, never a `500`.**
  - **Under `kindgi dev`,** a secret is a key in your env files. No env-file quoting holds a value that has a double quote, or a backslash followed by `n` or `r`, together with a carriage return or with both a single quote and a backtick.
    - Such a value is refused with `400 secret-value-invalid`, the new code, before any file is read. It used to answer `500 secret-store-error`.
    - The message says why and never repeats the value.
    - This applies to `POST /v1/secrets`, `PATCH /v1/tenant/config` and `POST /v1/deployments/{deploymentId}/secrets`.
  - **`SecretError` gains the codes a store's `set` refuses with:** `reserved-name-prefix`, `secret-name-invalid`, `secret-value-too-large` and `secret-value-invalid`. A store that rotates by setting a new version can answer a rotation's new value as it answers the write, and `POST /v1/secrets/{name}/rotate` answers any of them it gets at `400`.
  - **The API reference:**
    - lists `secret-value-invalid` beside the other refusals for those three operations;
    - gives `POST /v1/secrets/{name}/rotate` its `400` (`secret-value-too-large`, `reserved-name-prefix`);
    - lists the `429`, `502` and `503` an external provider answers for the rotation and the deployment sync, as it already did for the other two.
- d985473: **`GET /v1/secrets` reads `includeRevoked`, and the `kindgi dev` secrets store pages.**
  - `?includeRevoked=true` lists revoked secrets too, with `revokedAt` and `revokeReason`. It's metadata only, never a value. The route used to drop it, so `kindgi secrets list --include-revoked` and the TypeScript client's `secrets.list({ includeRevoked })` did nothing; now they reach the store. The operation documents the parameter, and the Python client's `secrets.list` gains `include_revoked`.
  - `SecretBinding.list`'s contract says what a store returns: name order, at most `limit` records, and a `nextCursor` while more remain. `listVersions`' says the same, oldest first.
  - `GET /v1/secrets` and `GET /v1/secrets/{name}/versions` answer `400 bad-input` to a `cursor` the store didn't issue, as the agents, flows, policies and eval-suites version lists do, so a client paging until done is never sent back to the first page. A store says which cursors it issued with `SecretBinding.issuedCursor` (optional: a store without it gets any cursor, as before); `@kindgi/secrets-dotenv` has it.
  - `@kindgi/secrets-dotenv` pages by name: a `nextCursor` while more remain, and the next page starts after the page's last name, so a name added between pages neither repeats nor skips another. Before, it stopped at `limit`, and a 26th secret was out of reach.
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
  - @kindgi/dotenv-file@0.1.8-rc.0

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
  - @kindgi/api@0.1.7
  - @kindgi/types@0.1.7
  - @kindgi/platform@0.1.7
  - @kindgi/dotenv-file@0.1.7

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
  - @kindgi/api@0.1.7-rc.0
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/platform@0.1.7-rc.0
  - @kindgi/dotenv-file@0.1.7-rc.0

## 0.1.6

### Patch Changes

- 307771f: Under `kindgi dev`, Kindgi keeps the secrets you store in its own file, `.kindgi/secrets.env`, instead of your app's `.env.local`. A framework like Next.js or Vite loads `.env.local` into every route of your app, so a model key stored there was readable by code that never needs it.
  
  - `kindgi secrets set … --env=local` writes `.kindgi/secrets.env`: owner-only, under the gitignored `.kindgi/`, read after your app's `.env` and `.env.local`, so its value wins. `--app` writes your app's env file instead, for a value both read, such as a webhook signing secret (`appEnvFile` on `POST /v1/secrets`; a runtime with a secrets store refuses it).
  - `kindgi secrets copy [NAME…]` copies model providers' keys (or the names given) from your app's env files into `.kindgi/secrets.env`, merge-only and as written. It never edits or deletes anything in your app's files; it says, per key, that the key is still there and whether git tracks the file. `kindgi dev` gives a one-time hint when it uses a provider's key from a file your app loads.
  - Under `kindgi dev`, the pack service's environment no longer holds a secret stored with `kindgi secrets` (a tool reads it from `ctx.secrets`, as in a deployment), nor any model provider's key, whichever env file holds it. `GET /v1/providers/{providerId}/check` carries the provider's `secretRef` by name, never its value, which is how `kindgi dev` knows the names.
  - A command that can't read an env file says so instead of crashing: `kindgi doctor` reports the model-key check as skipped, `kindgi dev` names the file it can't read, and `kindgi providers register` asks the runtime instead.
- Updated dependencies [70c8d1f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [fd93b3e]
- Updated dependencies [a6ac2e9]
- Updated dependencies [fdb86ae]
- Updated dependencies [de726fe]
- Updated dependencies [fdb86ae]
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
  - @kindgi/types@0.1.6
  - @kindgi/platform@0.1.6
  - @kindgi/dotenv-file@0.1.6

## 0.1.6-rc.0

### Patch Changes

- 307771f: Under `kindgi dev`, Kindgi keeps the secrets you store in its own file, `.kindgi/secrets.env`, instead of your app's `.env.local`. A framework like Next.js or Vite loads `.env.local` into every route of your app, so a model key stored there was readable by code that never needs it.
  
  - `kindgi secrets set … --env=local` writes `.kindgi/secrets.env`: owner-only, under the gitignored `.kindgi/`, read after your app's `.env` and `.env.local`, so its value wins. `--app` writes your app's env file instead, for a value both read, such as a webhook signing secret (`appEnvFile` on `POST /v1/secrets`; a runtime with a secrets store refuses it).
  - `kindgi secrets copy [NAME…]` copies model providers' keys (or the names given) from your app's env files into `.kindgi/secrets.env`, merge-only and as written. It never edits or deletes anything in your app's files; it says, per key, that the key is still there and whether git tracks the file. `kindgi dev` gives a one-time hint when it uses a provider's key from a file your app loads.
  - Under `kindgi dev`, the pack service's environment no longer holds a secret stored with `kindgi secrets` (a tool reads it from `ctx.secrets`, as in a deployment), nor any model provider's key, whichever env file holds it. `GET /v1/providers/{providerId}/check` carries the provider's `secretRef` by name, never its value, which is how `kindgi dev` knows the names.
  - A command that can't read an env file says so instead of crashing: `kindgi doctor` reports the model-key check as skipped, `kindgi dev` names the file it can't read, and `kindgi providers register` asks the runtime instead.
- Updated dependencies [70c8d1f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [fd93b3e]
- Updated dependencies [a6ac2e9]
- Updated dependencies [fdb86ae]
- Updated dependencies [de726fe]
- Updated dependencies [fdb86ae]
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
  - @kindgi/types@0.1.6-rc.0
  - @kindgi/platform@0.1.6-rc.0
  - @kindgi/dotenv-file@0.1.6-rc.0

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
- Updated dependencies [60c0cca]
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
  - @kindgi/dotenv-file@0.1.5
  - @kindgi/types@0.1.5
  - @kindgi/platform@0.1.5

## 0.1.5-rc.0

### Patch Changes

- Updated dependencies [0919fe6]
- Updated dependencies [9801f25]
- Updated dependencies [490d083]
- Updated dependencies [cb20b9a]
- Updated dependencies [f19bc64]
- Updated dependencies [ede39f3]
- Updated dependencies [60c0cca]
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
  - @kindgi/dotenv-file@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0
  - @kindgi/platform@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 52c8f98: Rotating or revoking a secret under `kindgi dev` (the env-file store) answered `500 secret-store-error`, which reads as "the server broke, try again". The store doesn't do either by design, so it's now `501 secret-operation-unsupported`. The message says what to do instead: edit the value in the env files, or remove the name there. `SecretError` gains the code.
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
- Updated dependencies [86ec2ef]
- Updated dependencies [e97958c]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [e2ab2ac]
- Updated dependencies [fac7472]
- Updated dependencies [52c8f98]
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
  - @kindgi/types@0.1.4
  - @kindgi/platform@0.1.4
  - @kindgi/dotenv-file@0.1.4

## 0.1.4-rc.5

### Patch Changes

- 52c8f98: Rotating or revoking a secret under `kindgi dev` (the env-file store) answered `500 secret-store-error`, which reads as "the server broke, try again". The store doesn't do either by design, so it's now `501 secret-operation-unsupported`. The message says what to do instead: edit the value in the env files, or remove the name there. `SecretError` gains the code.
- Updated dependencies [29fbd56]
- Updated dependencies [52c8f98]
- Updated dependencies [9801f64]
  - @kindgi/api@0.1.4-rc.5
  - @kindgi/dotenv-file@0.1.4-rc.5
  - @kindgi/platform@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- Updated dependencies [5608264]
  - @kindgi/api@0.1.4-rc.4
  - @kindgi/dotenv-file@0.1.4-rc.4
  - @kindgi/platform@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- Updated dependencies [3e427c5]
  - @kindgi/api@0.1.4-rc.3
  - @kindgi/dotenv-file@0.1.4-rc.3
  - @kindgi/platform@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [0b1f48d]
- Updated dependencies [2b34f78]
- Updated dependencies [9a7f43b]
- Updated dependencies [fcc6a97]
- Updated dependencies [86ec2ef]
- Updated dependencies [e97958c]
- Updated dependencies [e2ab2ac]
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
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2
  - @kindgi/dotenv-file@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [0359caf]
- Updated dependencies [b8ff156]
- Updated dependencies [06b5fc0]
- Updated dependencies [8861bf8]
- Updated dependencies [f90c285]
  - @kindgi/api@0.1.4-rc.1
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/dotenv-file@0.1.4-rc.1
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
  - @kindgi/dotenv-file@0.1.4-rc.0

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
  - @kindgi/platform@0.1.3
  - @kindgi/dotenv-file@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
- Updated dependencies [610a9de]
  - @kindgi/api@0.1.2
  - @kindgi/dotenv-file@0.1.2
  - @kindgi/platform@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [786ea98]
- Updated dependencies [324aba4]
  - @kindgi/api@0.1.1
  - @kindgi/dotenv-file@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: Kindgi inside an existing app: project-local configuration, the app's own env files, nothing leaks.
  
  - **BREAKING — `@kindgi/env-schema`:** the runtime reads only `KINDGI_*` names. `DATABASE_URL` → `KINDGI_DATABASE_URL`, `OPENFGA_API_URL` → `KINDGI_OPENFGA_API_URL`, with no fallback; every unprefixed name belongs to the agents.
  - **`@kindgi/dotenv-file`:** parses the dotenv format the way applications do (verified against `dotenv@16.3.1`), adds `${VAR}` expansion (agrees with dotenv-expand 10 and 12 where they agree) and layered reading. The writer keeps hand-written lines byte for byte and refuses values it can't write back unchanged.
  - **`@kindgi/handler-runtime`:** `loadKindgiConfig` — one loader for `kindgi.config.*` (including `.mts` for CommonJS hosts) that reports a broken config's cause; `resolveDiscovery` walks only each discovery pattern's fixed prefix instead of the whole host repo.
  - **`@kindgi/secrets-dotenv`:** one resolver for a pack's env files (`.env` < `.env.local`, or `dev.envFiles`). `KINDGI_*` names never resolve as secrets, dev writes go only to `.env.local`, and warnings name `file:line`, never the line itself.
  - **`@kindgi/sdk`:** authoring skills updated (a handler with nothing to `await` can return `Promise.resolve`).

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
- Updated dependencies [aec851d]
  - @kindgi/api@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/dotenv-file@0.1.0
  - @kindgi/platform@0.1.0
