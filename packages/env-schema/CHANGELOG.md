# @kindgi/env-schema

## 0.3.2

No changes in this release.

## 0.3.1

No changes in this release.

## 0.3.1-rc.1

No changes in this release.

## 0.3.1-rc.0

No changes in this release.

## 0.3.0

### Patch Changes

- af11ccc: `KINDGI_SEED_USER_ID`'s description says the id is a UUID, as the tenant id's already does, and that the runtime reads it in lower case.

## 0.3.0-rc.0

### Patch Changes

- af11ccc: `KINDGI_SEED_USER_ID`'s description says the id is a UUID, as the tenant id's already does, and that the runtime reads it in lower case.

## 0.2.0

### Patch Changes

- 68e0d57: **A deployment can show links of its own in the console.** `GET /v1/auth/sign-in-options` gains an optional `links: [{ label, url }]`: the deployment's own links, such as its help desk, status page or data processing terms, for the console to show on every page, the sign-in page too. They come in the order the operator gave, with each label trimmed and each URL as a browser reads it. The answer has no `links` when there are none, and older servers leave it out too.
  - `createApp`'s new `consoleLinks` sets them. It throws on more than 8 links, on a label that isn't 1 to 40 characters once trimmed, has a control or format character (as a site's display name, `hasHiddenCharacters`) or is another link's once trimmed, and on a URL that isn't an absolute https URL with no username or password.
  - **Only lookups with an email count toward the sign-in options' rate limit.** A read without an email is answered with the deployment's configuration, the same for everyone, so it isn't counted. The console reads it on every page load for the links, and those reads no longer spend the sign-in page's budget for a client address.
  - `@kindgi/env-schema` adds `KINDGI_CONSOLE_LINKS`, a JSON object of label to URL, for a runtime to read them from.
  - The TypeScript and Python clients' sign-in options gain `links`. The OpenAPI document names the item `ConsoleLink`.
- 68e0d57: **Two server settings that have the runtime check its database server's certificate against a CA you give** (runtime 0.2.0 on):
  - **`KINDGI_DATABASE_SERVER_CA_PATH`:** a PEM file of the CA certificates the database server's certificate must chain to. Set, every connection uses TLS whatever the URL's `sslmode` says, and the certificate must chain to one of these CAs and be in date. Its name is checked too only with `sslmode=verify-full`. For a database reached by an address its certificate doesn't name, such as Cloud SQL by private IP with its per-instance CA.
  - **`KINDGI_DATABASE_SERVER_CA`:** the same certificates inline, for platforms that give settings as environment variables. One or the other, not both.
- 87a5290: Four descriptions now say what the server does. `KINDGI_ERASURE_SHARED_WAIT_MS` is at least 3600000 (an hour), or the server refuses to start. `KINDGI_SESSION_TTL_MS` and `KINDGI_SESSION_IDLE_TIMEOUT_MS` say the server refuses to start below their minimum, and when either is set where nobody can open a browser session (sign-in with identity providers off and console token sign-in off). `KINDGI_SESSION_TTL_MS` below an hour needs `KINDGI_SESSION_IDLE_TIMEOUT_MS` set no longer than it, since the idle default is an hour. `KINDGI_PACK_SERVICE_TOKEN` suggests `openssl rand -hex 32`, as its error message already does, and so do the self-host and rotate-keys guides.
- 68e0d57: `KINDGI_OPENFGA_API_URL`'s description says what a runtime without it does, instead of saying production must set it. No roles are checked: every key and every sign-in works in every project, and only the tenant admin (the API token or an `admin` key) changes tenant settings. That suits one tenant whose people trust each other. `KINDGI_TENANCY=multi` refuses to start without it.

## 0.2.0-rc.1

No changes in this release.

## 0.2.0-rc.0

### Patch Changes

- 68e0d57: **A deployment can show links of its own in the console.** `GET /v1/auth/sign-in-options` gains an optional `links: [{ label, url }]`: the deployment's own links, such as its help desk, status page or data processing terms, for the console to show on every page, the sign-in page too. They come in the order the operator gave, with each label trimmed and each URL as a browser reads it. The answer has no `links` when there are none, and older servers leave it out too.
  - `createApp`'s new `consoleLinks` sets them. It throws on more than 8 links, on a label that isn't 1 to 40 characters once trimmed, has a control or format character (as a site's display name, `hasHiddenCharacters`) or is another link's once trimmed, and on a URL that isn't an absolute https URL with no username or password.
  - **Only lookups with an email count toward the sign-in options' rate limit.** A read without an email is answered with the deployment's configuration, the same for everyone, so it isn't counted. The console reads it on every page load for the links, and those reads no longer spend the sign-in page's budget for a client address.
  - `@kindgi/env-schema` adds `KINDGI_CONSOLE_LINKS`, a JSON object of label to URL, for a runtime to read them from.
  - The TypeScript and Python clients' sign-in options gain `links`. The OpenAPI document names the item `ConsoleLink`.
- 68e0d57: **Two server settings that have the runtime check its database server's certificate against a CA you give** (runtime 0.2.0 on):
  - **`KINDGI_DATABASE_SERVER_CA_PATH`:** a PEM file of the CA certificates the database server's certificate must chain to. Set, every connection uses TLS whatever the URL's `sslmode` says, and the certificate must chain to one of these CAs and be in date. Its name is checked too only with `sslmode=verify-full`. For a database reached by an address its certificate doesn't name, such as Cloud SQL by private IP with its per-instance CA.
  - **`KINDGI_DATABASE_SERVER_CA`:** the same certificates inline, for platforms that give settings as environment variables. One or the other, not both.
- 87a5290: Four descriptions now say what the server does. `KINDGI_ERASURE_SHARED_WAIT_MS` is at least 3600000 (an hour), or the server refuses to start. `KINDGI_SESSION_TTL_MS` and `KINDGI_SESSION_IDLE_TIMEOUT_MS` say the server refuses to start below their minimum, and when either is set where nobody can open a browser session (sign-in with identity providers off and console token sign-in off). `KINDGI_SESSION_TTL_MS` below an hour needs `KINDGI_SESSION_IDLE_TIMEOUT_MS` set no longer than it, since the idle default is an hour. `KINDGI_PACK_SERVICE_TOKEN` suggests `openssl rand -hex 32`, as its error message already does, and so do the self-host and rotate-keys guides.
- 68e0d57: `KINDGI_OPENFGA_API_URL`'s description says what a runtime without it does, instead of saying production must set it. No roles are checked: every key and every sign-in works in every project, and only the tenant admin (the API token or an `admin` key) changes tenant settings. That suits one tenant whose people trust each other. `KINDGI_TENANCY=multi` refuses to start without it.

## 0.1.10

### Patch Changes

- 6b3f48c: **`KINDGI_DB_POOL_WAIT_TIMEOUT_MS`** (runtime 0.1.9 on): how long a query waits for one of the server's pooled database connections while every one is taken, 10000 ms by default; 0 turns it off. Past it the query fails before it runs: a GET or HEAD answers 503 `database-busy` with `Retry-After: 5` (under `/auth/`, a browser signing in is sent back to the sign-in page instead), any other request 500. The admin commands wait as long as it takes. The statement and lock timeouts' descriptions now say the same of the GETs and HEADs they end.
- e03762c: **Three server settings for the timeouts on the runtime's own database connections** (runtime 0.1.9 on). Each is in milliseconds, and 0 turns it off. Anything but a whole number up to 2147483647 stops the boot, naming the variable.
  - **`KINDGI_DB_STATEMENT_TIMEOUT_MS`:** how long one statement may run (`statement_timeout`), 60000 by default. The migrations at boot, an index built `CONCURRENTLY` and the admin commands run with none.
  - **`KINDGI_DB_LOCK_TIMEOUT_MS`:** how long a statement may wait for a lock (`lock_timeout`), 30000 by default. It must be shorter than the statement timeout when both are on.
  - **`KINDGI_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`:** how long a transaction may sit idle between statements (`idle_in_transaction_session_timeout`), 30000 by default.
- fde2432: **`KINDGI_ERASURE_LEDGER_EXPORT`** (runtime 0.1.10 on): each copy also names every tenant marked purged, by id and when it was created, and a new one is written when that changes too. After a restore, `kindgi-runtime tenants repurge` reads the newest copy here by default and purges those tenants again, even one whose purge record is gone.
- 43eafb2: A deployment without a secrets store (`KINDGI_SECRETS_BACKEND=none`) can say it takes no identity provider of a tenant's own: a provider's client secret and keys are references into a store. The binding's `register` and `update` may answer `{ kind: 'needs-secrets-store' }`, and `POST /v1/auth/providers` and `PATCH /v1/auth/providers/{providerId}` then answer `409 identity-providers-need-secrets-store`: "This deployment has no secrets store (KINDGI_SECRETS_BACKEND), and an identity provider's client secret and keys are references into one: identity providers can't be added or changed here until it has one." Removing a provider still works. The clients read the new code as a conflict, by its status. `KINDGI_SECRETS_BACKEND`'s description in the environment schema says so.
- 05b762e: **New system route `POST /v1/system/tenants/{tenantId}/purge`:** purges a closed tenant for good, once its 30-day export window has passed, as `kindgi-runtime tenants purge` does: every row of it, its artifacts' bytes and its authorization store, then its purge record, then the mark. `confirm` is the tenant's slug. It takes `system:tenants:purge`, which no other scope includes, or `kindgi:system`. Until now that scope could be put on a key and reached nothing.
  
  - **It answers when done:** `complete`, what it deleted per table (`deleted`, `objectsDeleted`, `authzStoreDeleted`), and what's left (`left`, `objectsLeft`, `leftBecause`). With `complete: false`, or a call that ended before its answer, run it again. On a tenant already purged it deletes what was written after its mark (`alreadyPurged: true`). Every call is on the operator's access record.
  - **Refused, with nothing changed:** `400 tenant-slug-mismatch`; `409 tenant-not-closing`, `tenant-export-window-open`, `purge-record-unset` and `purge-setting-missing`. A runtime that doesn't purge answers `501 tenant-purge-unsupported`.
  - **A failed delete of its OpenFGA store** is `502 authz-store-delete-failed`, and its message says what that left. Run it again.
  - **`SystemTenantsBinding.purge`** is optional. `withSystemTenantContext` takes `admitPurged`, so the purge's route reaches a tenant already purged; every other system route still answers `404 tenant-not-found` for one.
  - **New runtime setting `KINDGI_TENANT_PURGE_RECORD`** (`local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`): where the server writes purge records. The route refuses every purge while it's unset.
  - **Clients:** `client.systemTenants.purge(tenantId, confirm, { idempotencyKey, timeoutMs })` in TypeScript (`TenantPurge`), and `client.system_tenants.purge(tenant_id, confirm=…, idempotency_key=…, timeout=…)` in Python.
- 9b6da8a: **Usage reads: a tenant reads its own usage, aggregated, and the operator reads usage across tenants.**
  
  - **What's counted:** usage records (`USAGE_KINDS`): runs started and ended, each with its class; approvals requested and decided; model calls, inference and embedding; and a project put in production or taken out. A read answers groups: each group's count, the sum of its quantities (milliseconds for `run.ended`, tokens for model calls, and 1 for every other record, so a group of those has a quantity equal to its count) and its first and last times. It never answers a record's content. Model-call cost stays on `/v1/cost`.
  - **The query,** the same on both routes:
    - `from` and `to`: times with a zone, `to` not included, at most 92 days apart. A longer span is read in parts;
    - `groupBy`, comma-separated;
    - the filters `kind`, `class` and `state`, each comma-separated. A list naming an unknown value, or one value twice, is `400 bad-input`;
    - `limit`: groups a page, from 1 to 10000 (default 1000);
    - `cursor`: the last page's `nextCursor`. A cursor the route didn't give is `400 bad-input`.
  - **The answer** is `{ data, watermark, nextCursor? }`. Every record at or before `watermark` is in it, so a reader re-reads a window until its watermark is past the window's end. Every page of one read carries the same watermark. A group's `kind`, `class` and `state` are plain strings: a runtime may count more later, and a reader shows a value it doesn't know as it is.
  - **`GET /v1/usage`:** the caller's tenant's usage. `groupBy` takes `project`, `agent`, `kind`, `class`, `state` and `day` (the UTC date); the default is `project,kind`. `projectId` reads one project.
    - **Which projects:** a tenant admin, or a deployment without authorization, reads every project and the tenant's records with no project. Anyone else, an admin's API key limited to a project included, reads only the projects they may `read`, and no record without a project.
    - **A project the caller can't read** is absent from the answer, never an error, so the answer doesn't say it exists.
    - **When the projects a caller may read can't be listed,** one asked for with `projectId` is still read. A read across projects is refused (`403`), never over-counted.
  - **`GET /v1/system/usage`** takes the new system capability `system:usage:read` (`kindgi:system` includes it). `groupBy` also takes `tenant`; the default is `tenant,kind`. `tenantId` reads one tenant.
    - A test tenant's usage, and that of a tenant whose setup is pending, is never in the answer, even when `tenantId` names one.
    - The access record marks a read across every tenant, or names the one read.
  - **Mounting:** `createApp` takes `usage`, a `UsageBinding` (`acrossTenants`, `ofTenant`). Without it, neither route is mounted (`404`). `@kindgi/api` exports the binding's types and the lists the query takes (`USAGE_STATES`, `USAGE_GROUP_KEYS`, `TENANT_USAGE_GROUP_KEYS`, `USAGE_WINDOW_MAX_DAYS`).
  - **The TypeScript client** adds `client.usage.read` (`TenantUsageClient`) and `client.systemUsage.read` (`SystemUsageClient`); lists are sent comma-separated. `@kindgi/sdk` exports `TenantUsageClient`, `UsageQuery`, `UsagePage`, `UsageGroup` and `UsageGroupKey`. `UsageClient` is still `client.cost.usage`'s.
  - **The Python client** adds `client.usage.read` and `client.system_usage.read`.
  - **The CLI adds `kindgi usage`:**
    - **The window:** a calendar month in UTC (`--month=YYYY-MM`, the current one by default), or `--from` and `--to` together;
    - **The query:** `--project`, `--group-by`, `--kind`, `--class` and `--state` (comma-separated), `--limit` and `--cursor`;
    - **The output:** the page as JSON. `--table` prints a row per group, with `(none)` for no project or agent, and on stderr the watermark and the next page's `--cursor`.

## 0.1.10-rc.1

No changes in this release.

## 0.1.10-rc.0

### Patch Changes

- 6b3f48c: **`KINDGI_DB_POOL_WAIT_TIMEOUT_MS`** (runtime 0.1.9 on): how long a query waits for one of the server's pooled database connections while every one is taken, 10000 ms by default; 0 turns it off. Past it the query fails before it runs: a GET or HEAD answers 503 `database-busy` with `Retry-After: 5` (under `/auth/`, a browser signing in is sent back to the sign-in page instead), any other request 500. The admin commands wait as long as it takes. The statement and lock timeouts' descriptions now say the same of the GETs and HEADs they end.
- e03762c: **Three server settings for the timeouts on the runtime's own database connections** (runtime 0.1.9 on). Each is in milliseconds, and 0 turns it off. Anything but a whole number up to 2147483647 stops the boot, naming the variable.
  - **`KINDGI_DB_STATEMENT_TIMEOUT_MS`:** how long one statement may run (`statement_timeout`), 60000 by default. The migrations at boot, an index built `CONCURRENTLY` and the admin commands run with none.
  - **`KINDGI_DB_LOCK_TIMEOUT_MS`:** how long a statement may wait for a lock (`lock_timeout`), 30000 by default. It must be shorter than the statement timeout when both are on.
  - **`KINDGI_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`:** how long a transaction may sit idle between statements (`idle_in_transaction_session_timeout`), 30000 by default.
- fde2432: **`KINDGI_ERASURE_LEDGER_EXPORT`** (runtime 0.1.10 on): each copy also names every tenant marked purged, by id and when it was created, and a new one is written when that changes too. After a restore, `kindgi-runtime tenants repurge` reads the newest copy here by default and purges those tenants again, even one whose purge record is gone.
- 43eafb2: A deployment without a secrets store (`KINDGI_SECRETS_BACKEND=none`) can say it takes no identity provider of a tenant's own: a provider's client secret and keys are references into a store. The binding's `register` and `update` may answer `{ kind: 'needs-secrets-store' }`, and `POST /v1/auth/providers` and `PATCH /v1/auth/providers/{providerId}` then answer `409 identity-providers-need-secrets-store`: "This deployment has no secrets store (KINDGI_SECRETS_BACKEND), and an identity provider's client secret and keys are references into one: identity providers can't be added or changed here until it has one." Removing a provider still works. The clients read the new code as a conflict, by its status. `KINDGI_SECRETS_BACKEND`'s description in the environment schema says so.
- 05b762e: **New system route `POST /v1/system/tenants/{tenantId}/purge`:** purges a closed tenant for good, once its 30-day export window has passed, as `kindgi-runtime tenants purge` does: every row of it, its artifacts' bytes and its authorization store, then its purge record, then the mark. `confirm` is the tenant's slug. It takes `system:tenants:purge`, which no other scope includes, or `kindgi:system`. Until now that scope could be put on a key and reached nothing.
  
  - **It answers when done:** `complete`, what it deleted per table (`deleted`, `objectsDeleted`, `authzStoreDeleted`), and what's left (`left`, `objectsLeft`, `leftBecause`). With `complete: false`, or a call that ended before its answer, run it again. On a tenant already purged it deletes what was written after its mark (`alreadyPurged: true`). Every call is on the operator's access record.
  - **Refused, with nothing changed:** `400 tenant-slug-mismatch`; `409 tenant-not-closing`, `tenant-export-window-open`, `purge-record-unset` and `purge-setting-missing`. A runtime that doesn't purge answers `501 tenant-purge-unsupported`.
  - **A failed delete of its OpenFGA store** is `502 authz-store-delete-failed`, and its message says what that left. Run it again.
  - **`SystemTenantsBinding.purge`** is optional. `withSystemTenantContext` takes `admitPurged`, so the purge's route reaches a tenant already purged; every other system route still answers `404 tenant-not-found` for one.
  - **New runtime setting `KINDGI_TENANT_PURGE_RECORD`** (`local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`): where the server writes purge records. The route refuses every purge while it's unset.
  - **Clients:** `client.systemTenants.purge(tenantId, confirm, { idempotencyKey, timeoutMs })` in TypeScript (`TenantPurge`), and `client.system_tenants.purge(tenant_id, confirm=…, idempotency_key=…, timeout=…)` in Python.
- 9b6da8a: **Usage reads: a tenant reads its own usage, aggregated, and the operator reads usage across tenants.**
  
  - **What's counted:** usage records (`USAGE_KINDS`): runs started and ended, each with its class; approvals requested and decided; model calls, inference and embedding; and a project put in production or taken out. A read answers groups: each group's count, the sum of its quantities (milliseconds for `run.ended`, tokens for model calls, and 1 for every other record, so a group of those has a quantity equal to its count) and its first and last times. It never answers a record's content. Model-call cost stays on `/v1/cost`.
  - **The query,** the same on both routes:
    - `from` and `to`: times with a zone, `to` not included, at most 92 days apart. A longer span is read in parts;
    - `groupBy`, comma-separated;
    - the filters `kind`, `class` and `state`, each comma-separated. A list naming an unknown value, or one value twice, is `400 bad-input`;
    - `limit`: groups a page, from 1 to 10000 (default 1000);
    - `cursor`: the last page's `nextCursor`. A cursor the route didn't give is `400 bad-input`.
  - **The answer** is `{ data, watermark, nextCursor? }`. Every record at or before `watermark` is in it, so a reader re-reads a window until its watermark is past the window's end. Every page of one read carries the same watermark. A group's `kind`, `class` and `state` are plain strings: a runtime may count more later, and a reader shows a value it doesn't know as it is.
  - **`GET /v1/usage`:** the caller's tenant's usage. `groupBy` takes `project`, `agent`, `kind`, `class`, `state` and `day` (the UTC date); the default is `project,kind`. `projectId` reads one project.
    - **Which projects:** a tenant admin, or a deployment without authorization, reads every project and the tenant's records with no project. Anyone else, an admin's API key limited to a project included, reads only the projects they may `read`, and no record without a project.
    - **A project the caller can't read** is absent from the answer, never an error, so the answer doesn't say it exists.
    - **When the projects a caller may read can't be listed,** one asked for with `projectId` is still read. A read across projects is refused (`403`), never over-counted.
  - **`GET /v1/system/usage`** takes the new system capability `system:usage:read` (`kindgi:system` includes it). `groupBy` also takes `tenant`; the default is `tenant,kind`. `tenantId` reads one tenant.
    - A test tenant's usage, and that of a tenant whose setup is pending, is never in the answer, even when `tenantId` names one.
    - The access record marks a read across every tenant, or names the one read.
  - **Mounting:** `createApp` takes `usage`, a `UsageBinding` (`acrossTenants`, `ofTenant`). Without it, neither route is mounted (`404`). `@kindgi/api` exports the binding's types and the lists the query takes (`USAGE_STATES`, `USAGE_GROUP_KEYS`, `TENANT_USAGE_GROUP_KEYS`, `USAGE_WINDOW_MAX_DAYS`).
  - **The TypeScript client** adds `client.usage.read` (`TenantUsageClient`) and `client.systemUsage.read` (`SystemUsageClient`); lists are sent comma-separated. `@kindgi/sdk` exports `TenantUsageClient`, `UsageQuery`, `UsagePage`, `UsageGroup` and `UsageGroupKey`. `UsageClient` is still `client.cost.usage`'s.
  - **The Python client** adds `client.usage.read` and `client.system_usage.read`.
  - **The CLI adds `kindgi usage`:**
    - **The window:** a calendar month in UTC (`--month=YYYY-MM`, the current one by default), or `--from` and `--to` together;
    - **The query:** `--project`, `--group-by`, `--kind`, `--class` and `--state` (comma-separated), `--limit` and `--cursor`;
    - **The output:** the page as JSON. `--table` prints a row per group, with `(none)` for no project or agent, and on stderr the watermark and the next page's `--cursor`.

## 0.1.9

### Patch Changes

- 1ac8e67: **A deployment can publish the IP addresses its calls to other sites come from, and `kindgi egress` prints them,** for a site that admits only known addresses. Publishing them changes nothing about where calls go or come from.
  - **Settings:** `KINDGI_EGRESS_SERVER_ADDRESSES` (the server's own calls, such as to MCP servers and model providers, and its webhook deliveries) and `KINDGI_EGRESS_DEPLOYMENT_ADDRESSES` (calls made by deployed code), each a comma-separated list of IPv4 or IPv6 addresses. Unset: nothing is published.
  - **`GET /v1/tenant`** gains an optional `egress: { server, deployments }`, the same for every tenant on the deployment, which any key of the tenant reads. It's absent when the deployment publishes none, and from a runtime before it. For runtimes: `createApp`'s optional `egress` (`EgressAddresses`), whose entries must be IP addresses.
  - **`kindgi egress`** prints a CALLS / ADDRESS table, and says every tenant on the deployment shares the addresses, so a site keeps its own credentials too. `--json` prints both lists. With none published it says so, and exits 0.
  - The TypeScript and Python clients' `Tenant` gains the optional `egress`.
- 7be42d0: **New runtime setting `KINDGI_AUTH_INVITE_EMAIL_DAILY_CAP`:** the deployment's backstop on invitation emails, at most this many in 24 hours from all its tenants together. Default 500, a whole number from 1 to 100000. Each tenant's own limit stays: 100 in 24 hours, or 10 while `KINDGI_PRODUCTION_GATE` is `on` and the tenant isn't allowed production. At a limit the person is still added, without the email (`inviteEmail.reason` is `capped`), and sending it again answers `429 invite-capped`. It needs the emailed sign-in link's sender: set without `KINDGI_AUTH_EMAIL_SMTP_URL` (or `…_PATH`), the runtime refuses to start. `AUTH_INVITE_EMAIL_DAILY_CAP_VAR` names it.
  
  The API's texts for an invitation not emailed (`capped`) and for `429 invite-capped` name the deployment's backstop beside the tenant's limit (`openapi.json` descriptions only).
- d563887: **A runtime that keeps its values under one env refuses a value it would never read.** A runtime that serves one env, `prod` say, reads every value under it, so a secret set under `production` was stored and never read. Such a runtime can now refuse those values: `createApp({ envName, refuseOtherEnvs: true })` (`KINDGI_REFUSE_OTHER_ENVS=true` on the server, with `KINDGI_ENV`). Off by default; a runtime that leaves it off takes any env, as before.
  - **What it refuses, with `409 env-not-served`:**
    - a secret set or rotated, or an env value put, under another env (`POST /v1/secrets`, `POST /v1/secrets/{name}/rotate`, `PUT /v1/env/{name}`), and a deployment's secret sync under another env (`POST /v1/deployments/{deploymentId}/secrets`), before anything is written;
    - a model provider, MCP endpoint or webhook endpoint created or changed with its secret named under another env.
  - **The error** names the env the runtime serves and what to do (`details: { envName, servedEnv }`).
  - **What it still takes:**
    - reads and deletes under any env, so a value stored before can be found and removed;
    - a secret that a registration made before names under its own env, at the scope it's read at, so a value in use can still be rotated: a provider's or a webhook endpoint's at the tenant's scope, an MCP endpoint's at the scope recorded for it.
  - **whoami says what's served:** `GET /v1/identity/whoami` answers `servedEnv: { envName, refusesOtherEnvs }` when the runtime serves an env. The field is optional, and absent on a runtime that serves none.
  - **The CLI follows it.** On a runtime that refuses other envs:
    - `--env` defaults to the served env for `kindgi secrets`, `kindgi env` with `--scope`, `kindgi env pull` and `kindgi providers register --preset`;
    - `kindgi env set --scope`, `kindgi providers register --preset` and `kindgi deploy --sync-secrets` (before the build) are refused before anything is sent when they name another env;
    - `kindgi secrets set|rotate` under another env is sent, since only the runtime knows whether a registration still reads the secret there, and its refusal is shown;
    - elsewhere every default stays as it was.
  - **The MCP servers skill** says where a `--env=local` secret goes when the CLI is signed in to a hosted runtime.
- 1dc38b4: **`KINDGI_RUN_RETENTION_MAX_DAYS` is declared:** the longest a server keeps a finished run, in whole days. Unset, there's no limit.
- c44d803: **A second factor at sign-in, and a workspace setting that requires one, on a runtime that keeps them.** An authenticator app's codes (TOTP), with 10 recovery codes for when the app is lost. Covers the deployment's own ways in (the emailed link, and providers like Google, Microsoft and GitHub); signing in through the workspace's own identity provider is exempt, since it owns the second factor there. API keys aren't covered.
  
  - **The API.** A `secondFactor` binding (`SecondFactorBinding`) mounts:
    - `/v1/identity/me/second-factor`: `GET` yours (`setUp`, `since`, `recoveryCodesLeft`, `usable`, and whether the workspace `required` one); `POST` starts setting one up (the key and its `otpauth://` URI, shown once; replacing one takes a code from it), then `POST …/confirm {code}` sets it up and answers the 10 recovery codes, once; `POST …/recovery-codes` gives 10 new ones; `POST …/remove` takes it off, refused while the workspace requires one. From a session only (`400 auth-not-session-token` with an API key). A key or codes in an answer are never replayed for an `Idempotency-Key`.
    - `GET /v1/identity/users/{userId}/second-factor` and `POST …/second-factor/remove` (tenant admins): a person's, and removing it for a lost phone. Their sessions stay. An admin's own isn't removed there (`403 permission-denied`): it's taken off at `/me`, with a code from it.
    - `GET` / `PATCH /v1/auth/settings` `{ secondFactor: { required } }` (tenant admins), with how many people's keys are still on the previous sign-in secret (`onPreviousSecret`) or on neither (`unusable`). Once required, a session made without a second factor ends at its next request. Turning it on from a session made without one is `409 second-factor-enroll-first`.
    - Token sign-in is refused in a workspace that requires one: `403 second-factor-required`.
    - The sign-in history (`GET /v1/audit/sign-ins`) has three new kinds: `second-factor-set-up`, `second-factor-removed` (with `byUserId` when an admin removed it) and `recovery-codes-replaced`. It never has a key or a code.
    - New error codes: `second-factor-required`, `second-factor-invalid` (403), `second-factor-locked` (429, with `Retry-After`), `second-factor-unusable` (403), `second-factor-enroll-first`, `second-factor-not-set-up`, `second-factor-not-started` (409).
  - **A session says how its person gave a second factor.** `SessionCreateInput.secondFactor` and `Session.secondFactor` (optional): `{ method, at }`, where `method` is `totp`, `recovery-code`, `identity-provider`, or `site` (a site signed them in, and owns their second factor). A session store keeps it and returns it from `get` and `resolveToken`; `POST /v1/auth/refresh` gives the new session the same one.
  - **The TypeScript client.** `identity.me.secondFactor` (`get`, `start`, `confirm`, `newRecoveryCodes`, `remove`), `users.secondFactor(id)` and `users.removeSecondFactor(id)`, and `auth.settings` (`get`, `update`). A wrong code is an `auth` error whose `serverCode` is `second-factor-invalid`; too many is `rate-limited` (`second-factor-locked`), with `retryAfterSeconds`.
  - **The CLI.** `kindgi people second-factor <user-id>`, `kindgi people reset-second-factor <user-id>`, and `kindgi sign-in settings [--require-second-factor=on|off]`. `kindgi exports create` also writes `user-second-factors` (each person's status, never a key) and `sign-in-settings`.
  - **Runtime settings** (`@kindgi/env-schema`): `KINDGI_AUTH_PREVIOUS_SECRET_PATH` / `KINDGI_AUTH_PREVIOUS_SECRET`, optional: while the sign-in secret rotates, the one before it, so second-factor keys sealed under it still open.
- ec3dbf9: **Sign-in options can link the deployment's terms and privacy policy.** `GET /v1/auth/sign-in-options` gains an optional `legal: { termsUrl?, privacyUrl? }` for a sign-in page to link. It has only the ones the operator set, each an absolute https URL with no username or password, as a browser reads it, and the answer has no `legal` at all when neither is set. Older servers leave it out too.
  - `createApp`'s new `signInLegal` sets them. It throws on anything but an absolute https URL with no username or password.
  - `@kindgi/env-schema` adds `KINDGI_AUTH_TERMS_URL` and `KINDGI_AUTH_PRIVACY_URL`, for a runtime to read them from.
  - The TypeScript and Python clients' sign-in options gain `legal`.
- 409b9bf: A person a site signs in holds only the grants their site's sign-in writes. A deployment's bindings refuse any other grant naming such a person with `site-person-grants-managed`, and the API answers it as `403` on these routes:
  - adding a project or team member, or changing their role (`AddProjectMemberError`, `AddTeamMemberError` and `MembershipWriteError` gain the code);
  - granting tenant admin (`PersonGrantErrorCode`);
  - registering a reviewer (`ReviewerRegisterOutcome` gains a `refused` outcome);
  - removing such a person's project or team membership, or unregistering them as a reviewer (`ReviewerUnregisterOutcome` gains an optional `refused`). Their site would give it back at their next sign-in, so the answer points at the real levers: remove the person, change their role on the site, or pause the site.
  - minting an API key for such a person (`TokenMintRefusal` gains the code). Their access is only the sessions their site's sign-in gives, which end when the site is paused or unregistered; a key would outlive both.
  
  `@kindgi/env-schema` gains `KINDGI_SITE_SIGN_IN`: `true` lets sites sign their people in. The runtime needs authorization enforced and `KINDGI_PUBLIC_URL` for it; it's off by default.

## 0.1.9-rc.1

No changes in this release.

## 0.1.9-rc.0

### Patch Changes

- 1ac8e67: **A deployment can publish the IP addresses its calls to other sites come from, and `kindgi egress` prints them,** for a site that admits only known addresses. Publishing them changes nothing about where calls go or come from.
  - **Settings:** `KINDGI_EGRESS_SERVER_ADDRESSES` (the server's own calls, such as to MCP servers and model providers, and its webhook deliveries) and `KINDGI_EGRESS_DEPLOYMENT_ADDRESSES` (calls made by deployed code), each a comma-separated list of IPv4 or IPv6 addresses. Unset: nothing is published.
  - **`GET /v1/tenant`** gains an optional `egress: { server, deployments }`, the same for every tenant on the deployment, which any key of the tenant reads. It's absent when the deployment publishes none, and from a runtime before it. For runtimes: `createApp`'s optional `egress` (`EgressAddresses`), whose entries must be IP addresses.
  - **`kindgi egress`** prints a CALLS / ADDRESS table, and says every tenant on the deployment shares the addresses, so a site keeps its own credentials too. `--json` prints both lists. With none published it says so, and exits 0.
  - The TypeScript and Python clients' `Tenant` gains the optional `egress`.
- 7be42d0: **New runtime setting `KINDGI_AUTH_INVITE_EMAIL_DAILY_CAP`:** the deployment's backstop on invitation emails, at most this many in 24 hours from all its tenants together. Default 500, a whole number from 1 to 100000. Each tenant's own limit stays: 100 in 24 hours, or 10 while `KINDGI_PRODUCTION_GATE` is `on` and the tenant isn't allowed production. At a limit the person is still added, without the email (`inviteEmail.reason` is `capped`), and sending it again answers `429 invite-capped`. It needs the emailed sign-in link's sender: set without `KINDGI_AUTH_EMAIL_SMTP_URL` (or `…_PATH`), the runtime refuses to start. `AUTH_INVITE_EMAIL_DAILY_CAP_VAR` names it.
  
  The API's texts for an invitation not emailed (`capped`) and for `429 invite-capped` name the deployment's backstop beside the tenant's limit (`openapi.json` descriptions only).
- d563887: **A runtime that keeps its values under one env refuses a value it would never read.** A runtime that serves one env, `prod` say, reads every value under it, so a secret set under `production` was stored and never read. Such a runtime can now refuse those values: `createApp({ envName, refuseOtherEnvs: true })` (`KINDGI_REFUSE_OTHER_ENVS=true` on the server, with `KINDGI_ENV`). Off by default; a runtime that leaves it off takes any env, as before.
  - **What it refuses, with `409 env-not-served`:**
    - a secret set or rotated, or an env value put, under another env (`POST /v1/secrets`, `POST /v1/secrets/{name}/rotate`, `PUT /v1/env/{name}`), and a deployment's secret sync under another env (`POST /v1/deployments/{deploymentId}/secrets`), before anything is written;
    - a model provider, MCP endpoint or webhook endpoint created or changed with its secret named under another env.
  - **The error** names the env the runtime serves and what to do (`details: { envName, servedEnv }`).
  - **What it still takes:**
    - reads and deletes under any env, so a value stored before can be found and removed;
    - a secret that a registration made before names under its own env, at the scope it's read at, so a value in use can still be rotated: a provider's or a webhook endpoint's at the tenant's scope, an MCP endpoint's at the scope recorded for it.
  - **whoami says what's served:** `GET /v1/identity/whoami` answers `servedEnv: { envName, refusesOtherEnvs }` when the runtime serves an env. The field is optional, and absent on a runtime that serves none.
  - **The CLI follows it.** On a runtime that refuses other envs:
    - `--env` defaults to the served env for `kindgi secrets`, `kindgi env` with `--scope`, `kindgi env pull` and `kindgi providers register --preset`;
    - `kindgi env set --scope`, `kindgi providers register --preset` and `kindgi deploy --sync-secrets` (before the build) are refused before anything is sent when they name another env;
    - `kindgi secrets set|rotate` under another env is sent, since only the runtime knows whether a registration still reads the secret there, and its refusal is shown;
    - elsewhere every default stays as it was.
  - **The MCP servers skill** says where a `--env=local` secret goes when the CLI is signed in to a hosted runtime.
- 1dc38b4: **`KINDGI_RUN_RETENTION_MAX_DAYS` is declared:** the longest a server keeps a finished run, in whole days. Unset, there's no limit.
- c44d803: **A second factor at sign-in, and a workspace setting that requires one, on a runtime that keeps them.** An authenticator app's codes (TOTP), with 10 recovery codes for when the app is lost. Covers the deployment's own ways in (the emailed link, and providers like Google, Microsoft and GitHub); signing in through the workspace's own identity provider is exempt, since it owns the second factor there. API keys aren't covered.
  
  - **The API.** A `secondFactor` binding (`SecondFactorBinding`) mounts:
    - `/v1/identity/me/second-factor`: `GET` yours (`setUp`, `since`, `recoveryCodesLeft`, `usable`, and whether the workspace `required` one); `POST` starts setting one up (the key and its `otpauth://` URI, shown once; replacing one takes a code from it), then `POST …/confirm {code}` sets it up and answers the 10 recovery codes, once; `POST …/recovery-codes` gives 10 new ones; `POST …/remove` takes it off, refused while the workspace requires one. From a session only (`400 auth-not-session-token` with an API key). A key or codes in an answer are never replayed for an `Idempotency-Key`.
    - `GET /v1/identity/users/{userId}/second-factor` and `POST …/second-factor/remove` (tenant admins): a person's, and removing it for a lost phone. Their sessions stay. An admin's own isn't removed there (`403 permission-denied`): it's taken off at `/me`, with a code from it.
    - `GET` / `PATCH /v1/auth/settings` `{ secondFactor: { required } }` (tenant admins), with how many people's keys are still on the previous sign-in secret (`onPreviousSecret`) or on neither (`unusable`). Once required, a session made without a second factor ends at its next request. Turning it on from a session made without one is `409 second-factor-enroll-first`.
    - Token sign-in is refused in a workspace that requires one: `403 second-factor-required`.
    - The sign-in history (`GET /v1/audit/sign-ins`) has three new kinds: `second-factor-set-up`, `second-factor-removed` (with `byUserId` when an admin removed it) and `recovery-codes-replaced`. It never has a key or a code.
    - New error codes: `second-factor-required`, `second-factor-invalid` (403), `second-factor-locked` (429, with `Retry-After`), `second-factor-unusable` (403), `second-factor-enroll-first`, `second-factor-not-set-up`, `second-factor-not-started` (409).
  - **A session says how its person gave a second factor.** `SessionCreateInput.secondFactor` and `Session.secondFactor` (optional): `{ method, at }`, where `method` is `totp`, `recovery-code`, `identity-provider`, or `site` (a site signed them in, and owns their second factor). A session store keeps it and returns it from `get` and `resolveToken`; `POST /v1/auth/refresh` gives the new session the same one.
  - **The TypeScript client.** `identity.me.secondFactor` (`get`, `start`, `confirm`, `newRecoveryCodes`, `remove`), `users.secondFactor(id)` and `users.removeSecondFactor(id)`, and `auth.settings` (`get`, `update`). A wrong code is an `auth` error whose `serverCode` is `second-factor-invalid`; too many is `rate-limited` (`second-factor-locked`), with `retryAfterSeconds`.
  - **The CLI.** `kindgi people second-factor <user-id>`, `kindgi people reset-second-factor <user-id>`, and `kindgi sign-in settings [--require-second-factor=on|off]`. `kindgi exports create` also writes `user-second-factors` (each person's status, never a key) and `sign-in-settings`.
  - **Runtime settings** (`@kindgi/env-schema`): `KINDGI_AUTH_PREVIOUS_SECRET_PATH` / `KINDGI_AUTH_PREVIOUS_SECRET`, optional: while the sign-in secret rotates, the one before it, so second-factor keys sealed under it still open.
- ec3dbf9: **Sign-in options can link the deployment's terms and privacy policy.** `GET /v1/auth/sign-in-options` gains an optional `legal: { termsUrl?, privacyUrl? }` for a sign-in page to link. It has only the ones the operator set, each an absolute https URL with no username or password, as a browser reads it, and the answer has no `legal` at all when neither is set. Older servers leave it out too.
  - `createApp`'s new `signInLegal` sets them. It throws on anything but an absolute https URL with no username or password.
  - `@kindgi/env-schema` adds `KINDGI_AUTH_TERMS_URL` and `KINDGI_AUTH_PRIVACY_URL`, for a runtime to read them from.
  - The TypeScript and Python clients' sign-in options gain `legal`.
- 409b9bf: A person a site signs in holds only the grants their site's sign-in writes. A deployment's bindings refuse any other grant naming such a person with `site-person-grants-managed`, and the API answers it as `403` on these routes:
  - adding a project or team member, or changing their role (`AddProjectMemberError`, `AddTeamMemberError` and `MembershipWriteError` gain the code);
  - granting tenant admin (`PersonGrantErrorCode`);
  - registering a reviewer (`ReviewerRegisterOutcome` gains a `refused` outcome);
  - removing such a person's project or team membership, or unregistering them as a reviewer (`ReviewerUnregisterOutcome` gains an optional `refused`). Their site would give it back at their next sign-in, so the answer points at the real levers: remove the person, change their role on the site, or pause the site.
  - minting an API key for such a person (`TokenMintRefusal` gains the code). Their access is only the sessions their site's sign-in gives, which end when the site is paused or unregistered; a key would outlive both.
  
  `@kindgi/env-schema` gains `KINDGI_SITE_SIGN_IN`: `true` lets sites sign their people in. The runtime needs authorization enforced and `KINDGI_PUBLIC_URL` for it; it's off by default.

## 0.1.8

### Patch Changes

- ebf405d: **Three runtime settings, for keeping and using a backup's erasures:**
  - **`KINDGI_ERASURE_LEDGER_EXPORT`:** `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`. The server writes the erasure ledger of every tenant it serves there (keyed hashes only, never whom an erasure names), so erasures can be replayed after a backup restore. It writes a new file when the ledger changes, and at least one a day, and never overwrites or deletes one.
  - **`KINDGI_ERASURE_LEDGER_EXPORT_INTERVAL_MS`:** how often it writes. Default an hour, at least a minute, and it needs `KINDGI_ERASURE_LEDGER_EXPORT`.
  - **`KINDGI_PASSIVE`:** `on` boots a server that does nothing on its own, for looking at a restored backup before anyone uses it. No background work starts and no email goes out. Requests are still served, so keep a passive server where only you can reach it.
  
  The runtime's `--help` lists them.
- 8bde3fc: **The server settings say what a runtime serving many tenants starts with.**
  - **`KINDGI_TENANCY`:** `multi` starts only with all of these: `KINDGI_TENANT_HOST_ACCESS=isolated`, `KINDGI_PACK_ROUTING=per-deployment` with `KINDGI_PACK_ENDPOINT_HOSTS`, `KINDGI_OPENFGA_API_URL` with `KINDGI_OPENFGA_PRESHARED_KEY`, `KINDGI_PRODUCTION_GATE=on` and `KINDGI_USAGE_METERING=on`. A start that lacks any is refused, naming each. Each of those settings says so too.
  - **`KINDGI_PACK_ENDPOINT_HOSTS`:** unset, with `KINDGI_PACK_ROUTING=per-deployment`, the server refuses to start, since that routing needs `multi`. It used to say every endpoint is refused.
  - **`KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`** say they're used from runtime 0.1.8 (earlier runtimes ignore them), and `KINDGI_TENANT_HOST_ACCESS` that `isolated` is (earlier runtimes refuse it at startup).
  - **`KINDGI_ARTIFACT_MAX_BYTES`:** its default, 104857600 bytes, is 100 MiB, not 100 MB.
- cfe5422: **More cloud metadata endpoints are refused.** Besides 169.254.0.0/16, fe80::/10 and AWS's fd00:ec2::254, from runtime 0.1.8 the cloud metadata endpoints a runtime refuses also include Azure's 168.63.129.16, Alibaba Cloud's 100.100.100.200, EKS Pod Identity's fd00:ec2::23, Compute Engine's fd20:ce::254 (IPv6-only VMs), Akamai's fd00:a9fe:a9fe::1 and Scaleway's fd00:42::42.
  - `KINDGI_TENANT_HOST_ACCESS`'s description names them as the cloud metadata endpoints, not link-local addresses alone.
  - `KINDGI_WEBHOOK_PRIVATE_NETWORKS`'s description says they stay refused even with `allow`, though some sit inside CGNAT or IPv6 unique-local space. Its `allow` list also names IPv6 site-local, which runtime 0.1.8 counts as private.
  - `HostReach`'s `'metadata-network'` lists them, and says it also covers addresses no tenant has a reason to reach (multicast, reserved, documentation).
- ebf405d: **Two server settings for an OpenFGA that requires its callers to prove themselves.**
  - **`KINDGI_OPENFGA_PRESHARED_KEY`:** OpenFGA's preshared key (`--authn-method=preshared`), sent with every call as `Authorization: Bearer <key>`. It needs `KINDGI_OPENFGA_API_URL`, and is set by reference to a secret. The description says how to rotate it with no refusal: add the new key to OpenFGA's list, point the server at it, then drop the old one.
  - **`KINDGI_OPENFGA_AUTH`:** `none` (default) or `google-id-token`, which also sends a Google ID token from the server's own identity, for an OpenFGA on Cloud Run behind IAM. The token goes in `X-Serverless-Authorization`, since `Authorization` carries the key.
- ebf405d: **A pack service can be pinned to one tenant, and the server's settings for routing each call to its own deployment's pack service are declared** (pack protocol 2.7.0).
  - **`@kindgi/handler-runtime`:**
    - **`KINDGI_PACK_TENANT_ID`:** the tenant's id, a UUID, checked at startup: anything else, or the id no tenant has (`00000000-0000-4000-8000-000000000000`), stops the service from starting instead of refusing every call. It needs a runtime that sends the header (0.1.8 or later). With it set, the pack service refuses, with **421** and `{"code":"pack-tenant-mismatch"}`, a call to `/v1/invoke` or `/v1/info` whose `kindgi-tenant-id` header is missing or names another tenant, and a tool call whose context names another. It refuses before any pack code runs, and the answer names neither tenant. The health probes stay open. Unset (the default), nothing changes.
    - **Tenant ids compare without regard to case** (they're UUIDs).
    - **It's a backstop for a misrouted call to an honest pack.** The boundary is the server's routing.
    - **`PACK_HEADERS.tenantId`** (`kindgi-tenant-id`): the server sets it on every call to `/v1/invoke` and `/v1/info`, from the deployment it routed the call to.
    - **`GET /v1/info`** reports `indexHash`: `sha256:` and the hex SHA-256 of the service's index file, byte for byte, which is the hash a deployment signs.
  - **`@kindgi/env-schema`** (the routing settings are used from runtime 0.1.8; earlier runtimes ignore them):
    - **`KINDGI_PACK_TENANT_ID`** (the pack service);
    - **`KINDGI_PACK_ROUTING`:** `single` by default, or `per-deployment`, which needs `KINDGI_TENANCY=multi` (the server refuses it with one tenant). Under `per-deployment`, each endpoint carries its own token and auth, so `KINDGI_PACK_SERVICE_URL`, `KINDGI_PACK_SERVICE_TOKEN` and `KINDGI_PACK_SERVICE_AUTH` are refused;
    - **`KINDGI_PACK_ENDPOINT_HOSTS`:** host names; `*.` and a domain, which matches one more label; or `*-`, a tail and a domain, which matches one more label ending with `-` and the tail. On Cloud Run, the tail form, `*-<project number>.<region>.run.app`, is the one that admits only one project's services. `*.`, or a `*-` tail that isn't a project number, with `run.app` or a domain under it (`*.us-central1.run.app`, `*.a.run.app`, `*-uc.a.run.app`) is refused at startup: Cloud Run's shared domain would admit anyone's service. An endpoint's host must also begin with its deployment's own service name, whatever the allowlist.
  
    Their parsers are exported: `parsePackTenantId`, `parsePackRouting`, `parsePackEndpointHosts` and `packEndpointHostAllowed` (it takes a URL's `hostname`, not its `host`).
  - **`@kindgi/specs`:** the pack protocol schema gains the header, the 421, the optional process setting, and `info.indexHash`.
- ebf405d: **A project can be put in production, and the runtime can gate it.** A run in a project in production is a production run; a run anywhere else is staging.
  - **`PUT /v1/projects/{projectId}/production`**, body `{ "production": true | false }`, for tenant admins, both ways. It answers `{ projectId, productionSince }`, where `productionSince` is `null` once the project is out of production. Setting what's already set changes nothing and keeps the first `productionSince`. The TypeScript client has `projects.setProduction(projectId, production)`, and the Python client `projects.production.set(project_id, production=…)`.
  - **The production gate:** with `KINDGI_PRODUCTION_GATE=on`, putting a project in production is refused with `403 production-not-allowed` while the tenant isn't allowed it. The error's `details` carry the `projectId` and, from `KINDGI_PRODUCTION_NEXT_URL`, a `next` URL saying where to go. A project already in production stays so. Off by default, so nothing changes for a self-hosted runtime.
  - **Reads:** a project read shows `productionSince` while the project is in production. `GET /v1/tenant` gains optional `productionAllowed`, `productionNext` (only while it's `false`) and `limits`, when the runtime knows them.
  - **For runtimes:** `Project.productionSince?`, an optional `ProjectBinding.setProduction?` (without it, the route answers `501 production-unsupported`), and `TenantSummary`'s optional `productionAllowed` and `limits` (`TenantLimits`). `createApp` takes `production: { gate?, next? }`.
  - **The usage vocabulary:** `USAGE_CLASSES` (`production`, `staging`, `dry-run`, `replay`, `eval`, `child`) and `USAGE_KINDS`, for a runtime that counts usage (`KINDGI_USAGE_METERING`).
  - **New settings, documented:** `KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`.
- ebf405d: **A tenant can have a limit on its projects in production.** The new limit `projectsInProduction` sits in `TenantLimits`, beside the others, and is set through `PUT /v1/system/tenants/{tenantId}/limits`. It works like them: unset, it isn't enforced, and a self-hosted runtime sets none unless its operator does.
  - **The refusal:** with the limit set, `PUT /v1/projects/{projectId}/production` refuses another project with `403 production-limit-reached` while the tenant has that many in production, or more. `details` carries `limit: 'projects-in-production'`, the limit (`projectsInProduction`), the count (`inProduction`), the `projectId`, and `next` when the runtime names where to go (`KINDGI_PRODUCTION_NEXT_URL`).
  - **What's never counted or refused:** a project already in production answers its repeat 200, uncounted. Taking a project out is never refused.
  - **Lowering the limit** takes no project out of production. The next one waits until the count is under the limit.
  - **Order:** with the production gate on, a tenant that isn't allowed is refused `production-not-allowed` first.
  - **The binding:** `ProjectBinding.setProduction` reads the tenant's limit itself, where the runtime keeps it, and answers `limit-reached` (with the limit and the count) without a change. It reads the limit, counts the tenant's projects in production and changes the project in one step, so two projects put in production at once can't both take the last place, and a limit changed meanwhile is the one counted against. The in-memory binding takes its reader at construction (`productionLimit`). The conformance suite's `productionLimit` option checks a binding against it, setting the limit through the `setProductionLimit` its `makeBinding` returns.
  - **The count, read:** `GET /v1/system/tenants/{tenantId}/limits` answers an optional `inUse: { projectsInProduction }` from a runtime whose `SystemTenantSettingsBinding` has the new optional `inUse(tenantId)`. The count can be over a limit that was lowered below it.
  - **`KINDGI_PRODUCTION_NEXT_URL`** is the `details.next` of both refusals, `production-not-allowed` and `production-limit-reached`, and its description says so. `KINDGI_PRODUCTION_GATE`'s no longer assumes a payment card.
- ebf405d: **Tenants, for the operator of a runtime serving many tenants:** `/v1/system/tenants`, each route under its own system scope.
  - **`POST /v1/system/tenants`** (`system:tenants`) creates a tenant with its setup.
    - With `firstAdmin`, that person becomes its admin by email, and no key comes back. Without it, its first admin key comes back once, and that takes the full system capability, as does a `test` tenant.
    - It takes `productionAllowed` and `imagePrefix` (`<host>/<path>`) at creation.
    - A taken slug is `409 tenant-slug-taken`.
    - It's safe to retry with the same slug: if the tenant's setup didn't finish, the tenant waits, frozen, and the same request (the same name, slug, settings and first admin, under any Idempotency-Key) finishes it and answers as the first would have. Another request naming that slug is `409 tenant-slug-taken`.
    - A repeat of a create that finished is `409 tenant-slug-taken` too, unless it carries the first request's Idempotency-Key. Then it gets the first answer again, or `409 idempotency-key-replay-withheld` when that answer held the admin key, which is never sent twice.
  - **`GET /v1/system/tenants`** and **`GET /v1/system/tenants/{tenantId}`** (`system:tenants`) list and read tenants: never their content.
  - **`POST …/close`** (`system:tenants`) makes the tenant `closing`: readable and exportable with its own keys for its window, nothing runs. It's one-way.
  - **`PUT …/suspended`** (`system:suspend`, which no other scope includes) suspends or restores it, reversibly.
  - **`PUT …/image-prefix`** (`system:tenants`) sets the repository its deployments' images must sit in.
  - **`GET …/admins`** (`system:tenants:contacts`) returns its admins' contact addresses, for service notices only.
  - **`GET /v1/system/whoami`** answers any system key with its own id, scopes and expiry.
  
  The TypeScript client's `systemTenants` and `systemKeys.whoami`, and the Python client, gain the matching calls.
  
  **Also, from the reviews:**
  - **Least privilege at create:**
    - sign-up's key can hold `system:tenants:create` only;
    - a tenant created here starts with production **blocked**;
    - `productionAllowed: true` takes `system:tenants:production`;
    - `imagePrefix` takes the new `system:tenants:image-prefix`, as does `PUT …/image-prefix`;
    - asking for more than the key's scopes is refused naming the scope.
  - **The image prefix:**
    - changing one already set takes the full system capability;
    - no two tenants' prefixes overlap (`409 image-prefix-taken`; `imagePrefixesOverlap`).
  - **`PUT …/projects/{projectId}/suspended`** (`system:suspend`) suspends or restores one project.
  - **A closing or suspended tenant is frozen**, however it signs in: a key, a session or SigV4 (`createApp({ tenantStates })`, required with `tenancy: 'multi'`).
    - **What still works:** reading, its signed exports, signing in and out, deleting, erasure in every state before purge (`POST /v1/memory/erasures`, `…/replay`, `…/{erasureId}/resume`, and the retention sweeps), unregistering, and revoking keys and sessions.
    - **Anything else** is `409 tenant-closing` or `409 tenant-suspended`, registering or changing a sign-in provider included.
    - **If the state can't be read,** a write gets `503 tenant-state-unavailable`, failing closed.
    - **On `/s3`,** both answers are S3 error documents, which S3 clients parse: `403 AllAccessDisabled`, and `503 ServiceUnavailable` with `Retry-After`.
    - `GET /v1/tenant` carries `state`.
  - **On a runtime serving many tenants only, `POST /v1/deployments`** refuses an image outside the tenant's repository (`409 image-not-allowed`), before any registry read, and refuses a tenant without one (`409 image-prefix-unset`). A runtime serving one tenant never checks.
  - **The tenants list** carries `hasMore`.
  - **`KINDGI_TENANCY`** (`single`, the default, or `multi`) in `@kindgi/env-schema`: how many tenants the runtime serves.
- ebf405d: **`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and any sign-in as the server.
  - **`@kindgi/api`:**
    - `TENANT_HOST_ACCESS_LEVELS` gains `isolated`, so the `TenantHostAccess` union widens. A caller's exhaustive `switch` over it needs the new case.
    - `HostReach` gains `'private-network'` (RFC 1918, CGNAT 100.64.0.0/10, IPv6 unique-local and site-local) and `'server-credentials'` (signing in as the server: with credentials its environment holds, or as its own cloud identities). Only `isolated` denies them.
    - **`stdioRefusal(endpointId, level)`** now takes the level, and names it: "KINDGI_TENANT_HOST_ACCESS=isolated refuses that". Under `isolated`, registering a `stdio` MCP endpoint answers `403 host-access-denied`, as it does under `deployed`.
  - **`@kindgi/capabilities`:**
    - `AdapterFactoryInput.serverCredentials?` and `AdapterConfigCheckInput.serverCredentials?` (optional) say whether a registration may sign in as the server. Absent means allowed, as before.
    - `createAdapterFactoryRegistry(seed, { serverCredentials: false })` tells every factory and every `checkConfig`, and withholds the runtime's `identities` from them, so each check learns there are none. An input can't turn either back on.
  - **The adapters, with `serverCredentials: false`:** each refuses the registration in its check and its factory, with the same message, naming the alternative:
    - `@kindgi/adapter-model-gemini`: Vertex AI without `secret_ref`, which would sign in with Application Default Credentials;
    - `@kindgi/adapter-model-bedrock`: `auth: aws-identity`, the default (use `api-key`);
    - `@kindgi/adapter-model-azure-openai`: `auth: entra` (use the resource's API key).
  
    A registration with its own key is unchanged.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS` takes `isolated`, and its description says what the level refuses. The server won't start with `isolated` together with `KINDGI_DEV`, `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow` or `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`; those descriptions, and `KINDGI_AWS_IDENTITY`'s, say so.
  - **`@kindgi/sdk`:** the providers skill says that a runtime with `isolated` needs a Gemini service-account key in `secret_ref`.
- f05d320: **An agent turn's memory, charged by size, for a runtime that limits it.**
  - **`InvokeAgentBindings.turnMemory`,** optional: `charge(bytes, { runId })` (the turn's own run) answers `{ ok: true }`, or `{ ok: false, limit: 'tenant' | 'server', heldBytes, limitBytes }`. A runtime binds one per turn (one `invokeAgent` call), so two turns of one run are charged apart, and releases the turn's charge when it settles. Without it, nothing is charged.
  - **The charge** is taken before each model call: (4 + the iterations done) × the conversation as sent, in UTF-8 bytes, replacing the turn's last charge. The first is taken once the first messages are built. Each later one comes after the last tool results have joined the conversation and been journaled. A dry run is never charged.
  - **Refused,** the turn fails with `turn-memory-limit-reached` before the model is called, naming the limit, what it holds and its size. Every tool call the turn finished is already in the conversation, so a new turn there doesn't call it again.
  - **The API's error map** gains `429 turn-memory-limit-reached`, with no `Retry-After`. The clients read it as rate-limited, with the code in `serverCode`.
  - **Two runtime settings,** off unless set: `KINDGI_TURN_MEMORY_MIB` (every tenant's turns together) and `KINDGI_TURN_MEMORY_PER_TENANT_MIB` (one tenant's). Used from runtime 0.1.8.

## 0.1.8-rc.0

### Patch Changes

- ebf405d: **Three runtime settings, for keeping and using a backup's erasures:**
  - **`KINDGI_ERASURE_LEDGER_EXPORT`:** `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`. The server writes the erasure ledger of every tenant it serves there (keyed hashes only, never whom an erasure names), so erasures can be replayed after a backup restore. It writes a new file when the ledger changes, and at least one a day, and never overwrites or deletes one.
  - **`KINDGI_ERASURE_LEDGER_EXPORT_INTERVAL_MS`:** how often it writes. Default an hour, at least a minute, and it needs `KINDGI_ERASURE_LEDGER_EXPORT`.
  - **`KINDGI_PASSIVE`:** `on` boots a server that does nothing on its own, for looking at a restored backup before anyone uses it. No background work starts and no email goes out. Requests are still served, so keep a passive server where only you can reach it.
  
  The runtime's `--help` lists them.
- 8bde3fc: **The server settings say what a runtime serving many tenants starts with.**
  - **`KINDGI_TENANCY`:** `multi` starts only with all of these: `KINDGI_TENANT_HOST_ACCESS=isolated`, `KINDGI_PACK_ROUTING=per-deployment` with `KINDGI_PACK_ENDPOINT_HOSTS`, `KINDGI_OPENFGA_API_URL` with `KINDGI_OPENFGA_PRESHARED_KEY`, `KINDGI_PRODUCTION_GATE=on` and `KINDGI_USAGE_METERING=on`. A start that lacks any is refused, naming each. Each of those settings says so too.
  - **`KINDGI_PACK_ENDPOINT_HOSTS`:** unset, with `KINDGI_PACK_ROUTING=per-deployment`, the server refuses to start, since that routing needs `multi`. It used to say every endpoint is refused.
  - **`KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`** say they're used from runtime 0.1.8 (earlier runtimes ignore them), and `KINDGI_TENANT_HOST_ACCESS` that `isolated` is (earlier runtimes refuse it at startup).
  - **`KINDGI_ARTIFACT_MAX_BYTES`:** its default, 104857600 bytes, is 100 MiB, not 100 MB.
- cfe5422: **More cloud metadata endpoints are refused.** Besides 169.254.0.0/16, fe80::/10 and AWS's fd00:ec2::254, from runtime 0.1.8 the cloud metadata endpoints a runtime refuses also include Azure's 168.63.129.16, Alibaba Cloud's 100.100.100.200, EKS Pod Identity's fd00:ec2::23, Compute Engine's fd20:ce::254 (IPv6-only VMs), Akamai's fd00:a9fe:a9fe::1 and Scaleway's fd00:42::42.
  - `KINDGI_TENANT_HOST_ACCESS`'s description names them as the cloud metadata endpoints, not link-local addresses alone.
  - `KINDGI_WEBHOOK_PRIVATE_NETWORKS`'s description says they stay refused even with `allow`, though some sit inside CGNAT or IPv6 unique-local space. Its `allow` list also names IPv6 site-local, which runtime 0.1.8 counts as private.
  - `HostReach`'s `'metadata-network'` lists them, and says it also covers addresses no tenant has a reason to reach (multicast, reserved, documentation).
- ebf405d: **Two server settings for an OpenFGA that requires its callers to prove themselves.**
  - **`KINDGI_OPENFGA_PRESHARED_KEY`:** OpenFGA's preshared key (`--authn-method=preshared`), sent with every call as `Authorization: Bearer <key>`. It needs `KINDGI_OPENFGA_API_URL`, and is set by reference to a secret. The description says how to rotate it with no refusal: add the new key to OpenFGA's list, point the server at it, then drop the old one.
  - **`KINDGI_OPENFGA_AUTH`:** `none` (default) or `google-id-token`, which also sends a Google ID token from the server's own identity, for an OpenFGA on Cloud Run behind IAM. The token goes in `X-Serverless-Authorization`, since `Authorization` carries the key.
- ebf405d: **A pack service can be pinned to one tenant, and the server's settings for routing each call to its own deployment's pack service are declared** (pack protocol 2.7.0).
  - **`@kindgi/handler-runtime`:**
    - **`KINDGI_PACK_TENANT_ID`:** the tenant's id, a UUID, checked at startup: anything else, or the id no tenant has (`00000000-0000-4000-8000-000000000000`), stops the service from starting instead of refusing every call. It needs a runtime that sends the header (0.1.8 or later). With it set, the pack service refuses, with **421** and `{"code":"pack-tenant-mismatch"}`, a call to `/v1/invoke` or `/v1/info` whose `kindgi-tenant-id` header is missing or names another tenant, and a tool call whose context names another. It refuses before any pack code runs, and the answer names neither tenant. The health probes stay open. Unset (the default), nothing changes.
    - **Tenant ids compare without regard to case** (they're UUIDs).
    - **It's a backstop for a misrouted call to an honest pack.** The boundary is the server's routing.
    - **`PACK_HEADERS.tenantId`** (`kindgi-tenant-id`): the server sets it on every call to `/v1/invoke` and `/v1/info`, from the deployment it routed the call to.
    - **`GET /v1/info`** reports `indexHash`: `sha256:` and the hex SHA-256 of the service's index file, byte for byte, which is the hash a deployment signs.
  - **`@kindgi/env-schema`** (the routing settings are used from runtime 0.1.8; earlier runtimes ignore them):
    - **`KINDGI_PACK_TENANT_ID`** (the pack service);
    - **`KINDGI_PACK_ROUTING`:** `single` by default, or `per-deployment`, which needs `KINDGI_TENANCY=multi` (the server refuses it with one tenant). Under `per-deployment`, each endpoint carries its own token and auth, so `KINDGI_PACK_SERVICE_URL`, `KINDGI_PACK_SERVICE_TOKEN` and `KINDGI_PACK_SERVICE_AUTH` are refused;
    - **`KINDGI_PACK_ENDPOINT_HOSTS`:** host names; `*.` and a domain, which matches one more label; or `*-`, a tail and a domain, which matches one more label ending with `-` and the tail. On Cloud Run, the tail form, `*-<project number>.<region>.run.app`, is the one that admits only one project's services. `*.`, or a `*-` tail that isn't a project number, with `run.app` or a domain under it (`*.us-central1.run.app`, `*.a.run.app`, `*-uc.a.run.app`) is refused at startup: Cloud Run's shared domain would admit anyone's service. An endpoint's host must also begin with its deployment's own service name, whatever the allowlist.
  
    Their parsers are exported: `parsePackTenantId`, `parsePackRouting`, `parsePackEndpointHosts` and `packEndpointHostAllowed` (it takes a URL's `hostname`, not its `host`).
  - **`@kindgi/specs`:** the pack protocol schema gains the header, the 421, the optional process setting, and `info.indexHash`.
- ebf405d: **A project can be put in production, and the runtime can gate it.** A run in a project in production is a production run; a run anywhere else is staging.
  - **`PUT /v1/projects/{projectId}/production`**, body `{ "production": true | false }`, for tenant admins, both ways. It answers `{ projectId, productionSince }`, where `productionSince` is `null` once the project is out of production. Setting what's already set changes nothing and keeps the first `productionSince`. The TypeScript client has `projects.setProduction(projectId, production)`, and the Python client `projects.production.set(project_id, production=…)`.
  - **The production gate:** with `KINDGI_PRODUCTION_GATE=on`, putting a project in production is refused with `403 production-not-allowed` while the tenant isn't allowed it. The error's `details` carry the `projectId` and, from `KINDGI_PRODUCTION_NEXT_URL`, a `next` URL saying where to go. A project already in production stays so. Off by default, so nothing changes for a self-hosted runtime.
  - **Reads:** a project read shows `productionSince` while the project is in production. `GET /v1/tenant` gains optional `productionAllowed`, `productionNext` (only while it's `false`) and `limits`, when the runtime knows them.
  - **For runtimes:** `Project.productionSince?`, an optional `ProjectBinding.setProduction?` (without it, the route answers `501 production-unsupported`), and `TenantSummary`'s optional `productionAllowed` and `limits` (`TenantLimits`). `createApp` takes `production: { gate?, next? }`.
  - **The usage vocabulary:** `USAGE_CLASSES` (`production`, `staging`, `dry-run`, `replay`, `eval`, `child`) and `USAGE_KINDS`, for a runtime that counts usage (`KINDGI_USAGE_METERING`).
  - **New settings, documented:** `KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`.
- ebf405d: **A tenant can have a limit on its projects in production.** The new limit `projectsInProduction` sits in `TenantLimits`, beside the others, and is set through `PUT /v1/system/tenants/{tenantId}/limits`. It works like them: unset, it isn't enforced, and a self-hosted runtime sets none unless its operator does.
  - **The refusal:** with the limit set, `PUT /v1/projects/{projectId}/production` refuses another project with `403 production-limit-reached` while the tenant has that many in production, or more. `details` carries `limit: 'projects-in-production'`, the limit (`projectsInProduction`), the count (`inProduction`), the `projectId`, and `next` when the runtime names where to go (`KINDGI_PRODUCTION_NEXT_URL`).
  - **What's never counted or refused:** a project already in production answers its repeat 200, uncounted. Taking a project out is never refused.
  - **Lowering the limit** takes no project out of production. The next one waits until the count is under the limit.
  - **Order:** with the production gate on, a tenant that isn't allowed is refused `production-not-allowed` first.
  - **The binding:** `ProjectBinding.setProduction` reads the tenant's limit itself, where the runtime keeps it, and answers `limit-reached` (with the limit and the count) without a change. It reads the limit, counts the tenant's projects in production and changes the project in one step, so two projects put in production at once can't both take the last place, and a limit changed meanwhile is the one counted against. The in-memory binding takes its reader at construction (`productionLimit`). The conformance suite's `productionLimit` option checks a binding against it, setting the limit through the `setProductionLimit` its `makeBinding` returns.
  - **The count, read:** `GET /v1/system/tenants/{tenantId}/limits` answers an optional `inUse: { projectsInProduction }` from a runtime whose `SystemTenantSettingsBinding` has the new optional `inUse(tenantId)`. The count can be over a limit that was lowered below it.
  - **`KINDGI_PRODUCTION_NEXT_URL`** is the `details.next` of both refusals, `production-not-allowed` and `production-limit-reached`, and its description says so. `KINDGI_PRODUCTION_GATE`'s no longer assumes a payment card.
- ebf405d: **Tenants, for the operator of a runtime serving many tenants:** `/v1/system/tenants`, each route under its own system scope.
  - **`POST /v1/system/tenants`** (`system:tenants`) creates a tenant with its setup.
    - With `firstAdmin`, that person becomes its admin by email, and no key comes back. Without it, its first admin key comes back once, and that takes the full system capability, as does a `test` tenant.
    - It takes `productionAllowed` and `imagePrefix` (`<host>/<path>`) at creation.
    - A taken slug is `409 tenant-slug-taken`.
    - It's safe to retry with the same slug: if the tenant's setup didn't finish, the tenant waits, frozen, and the same request (the same name, slug, settings and first admin, under any Idempotency-Key) finishes it and answers as the first would have. Another request naming that slug is `409 tenant-slug-taken`.
    - A repeat of a create that finished is `409 tenant-slug-taken` too, unless it carries the first request's Idempotency-Key. Then it gets the first answer again, or `409 idempotency-key-replay-withheld` when that answer held the admin key, which is never sent twice.
  - **`GET /v1/system/tenants`** and **`GET /v1/system/tenants/{tenantId}`** (`system:tenants`) list and read tenants: never their content.
  - **`POST …/close`** (`system:tenants`) makes the tenant `closing`: readable and exportable with its own keys for its window, nothing runs. It's one-way.
  - **`PUT …/suspended`** (`system:suspend`, which no other scope includes) suspends or restores it, reversibly.
  - **`PUT …/image-prefix`** (`system:tenants`) sets the repository its deployments' images must sit in.
  - **`GET …/admins`** (`system:tenants:contacts`) returns its admins' contact addresses, for service notices only.
  - **`GET /v1/system/whoami`** answers any system key with its own id, scopes and expiry.
  
  The TypeScript client's `systemTenants` and `systemKeys.whoami`, and the Python client, gain the matching calls.
  
  **Also, from the reviews:**
  - **Least privilege at create:**
    - sign-up's key can hold `system:tenants:create` only;
    - a tenant created here starts with production **blocked**;
    - `productionAllowed: true` takes `system:tenants:production`;
    - `imagePrefix` takes the new `system:tenants:image-prefix`, as does `PUT …/image-prefix`;
    - asking for more than the key's scopes is refused naming the scope.
  - **The image prefix:**
    - changing one already set takes the full system capability;
    - no two tenants' prefixes overlap (`409 image-prefix-taken`; `imagePrefixesOverlap`).
  - **`PUT …/projects/{projectId}/suspended`** (`system:suspend`) suspends or restores one project.
  - **A closing or suspended tenant is frozen**, however it signs in: a key, a session or SigV4 (`createApp({ tenantStates })`, required with `tenancy: 'multi'`).
    - **What still works:** reading, its signed exports, signing in and out, deleting, erasure in every state before purge (`POST /v1/memory/erasures`, `…/replay`, `…/{erasureId}/resume`, and the retention sweeps), unregistering, and revoking keys and sessions.
    - **Anything else** is `409 tenant-closing` or `409 tenant-suspended`, registering or changing a sign-in provider included.
    - **If the state can't be read,** a write gets `503 tenant-state-unavailable`, failing closed.
    - **On `/s3`,** both answers are S3 error documents, which S3 clients parse: `403 AllAccessDisabled`, and `503 ServiceUnavailable` with `Retry-After`.
    - `GET /v1/tenant` carries `state`.
  - **On a runtime serving many tenants only, `POST /v1/deployments`** refuses an image outside the tenant's repository (`409 image-not-allowed`), before any registry read, and refuses a tenant without one (`409 image-prefix-unset`). A runtime serving one tenant never checks.
  - **The tenants list** carries `hasMore`.
  - **`KINDGI_TENANCY`** (`single`, the default, or `multi`) in `@kindgi/env-schema`: how many tenants the runtime serves.
- ebf405d: **`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and any sign-in as the server.
  - **`@kindgi/api`:**
    - `TENANT_HOST_ACCESS_LEVELS` gains `isolated`, so the `TenantHostAccess` union widens. A caller's exhaustive `switch` over it needs the new case.
    - `HostReach` gains `'private-network'` (RFC 1918, CGNAT 100.64.0.0/10, IPv6 unique-local and site-local) and `'server-credentials'` (signing in as the server: with credentials its environment holds, or as its own cloud identities). Only `isolated` denies them.
    - **`stdioRefusal(endpointId, level)`** now takes the level, and names it: "KINDGI_TENANT_HOST_ACCESS=isolated refuses that". Under `isolated`, registering a `stdio` MCP endpoint answers `403 host-access-denied`, as it does under `deployed`.
  - **`@kindgi/capabilities`:**
    - `AdapterFactoryInput.serverCredentials?` and `AdapterConfigCheckInput.serverCredentials?` (optional) say whether a registration may sign in as the server. Absent means allowed, as before.
    - `createAdapterFactoryRegistry(seed, { serverCredentials: false })` tells every factory and every `checkConfig`, and withholds the runtime's `identities` from them, so each check learns there are none. An input can't turn either back on.
  - **The adapters, with `serverCredentials: false`:** each refuses the registration in its check and its factory, with the same message, naming the alternative:
    - `@kindgi/adapter-model-gemini`: Vertex AI without `secret_ref`, which would sign in with Application Default Credentials;
    - `@kindgi/adapter-model-bedrock`: `auth: aws-identity`, the default (use `api-key`);
    - `@kindgi/adapter-model-azure-openai`: `auth: entra` (use the resource's API key).
  
    A registration with its own key is unchanged.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS` takes `isolated`, and its description says what the level refuses. The server won't start with `isolated` together with `KINDGI_DEV`, `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow` or `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`; those descriptions, and `KINDGI_AWS_IDENTITY`'s, say so.
  - **`@kindgi/sdk`:** the providers skill says that a runtime with `isolated` needs a Gemini service-account key in `secret_ref`.
- f05d320: **An agent turn's memory, charged by size, for a runtime that limits it.**
  - **`InvokeAgentBindings.turnMemory`,** optional: `charge(bytes, { runId })` (the turn's own run) answers `{ ok: true }`, or `{ ok: false, limit: 'tenant' | 'server', heldBytes, limitBytes }`. A runtime binds one per turn (one `invokeAgent` call), so two turns of one run are charged apart, and releases the turn's charge when it settles. Without it, nothing is charged.
  - **The charge** is taken before each model call: (4 + the iterations done) × the conversation as sent, in UTF-8 bytes, replacing the turn's last charge. The first is taken once the first messages are built. Each later one comes after the last tool results have joined the conversation and been journaled. A dry run is never charged.
  - **Refused,** the turn fails with `turn-memory-limit-reached` before the model is called, naming the limit, what it holds and its size. Every tool call the turn finished is already in the conversation, so a new turn there doesn't call it again.
  - **The API's error map** gains `429 turn-memory-limit-reached`, with no `Retry-After`. The clients read it as rate-limited, with the code in `serverCode`.
  - **Two runtime settings,** off unless set: `KINDGI_TURN_MEMORY_MIB` (every tenant's turns together) and `KINDGI_TURN_MEMORY_PER_TENANT_MIB` (one tenant's). Used from runtime 0.1.8.

## 0.1.7

### Patch Changes

- b90e2c6: A deployment can renew its own license key, when you run it. `kindgi license enroll --for <your GitHub login> --renewer <where to keep its key>` makes the deployment's renewer key pair once. It keeps the private half where you say, never printing it, and prints a line to add on access.kindgi.com, signed in as that login. After that, `kindgi license renew --key <where the license key is> --renewer <ref>` (or `--env-file kindgi.env`) asks for the key's next version, checks it offline the way the runtime does (Kindgi's signature, the same licensee and use, expiring no earlier), and writes it only when it's new. Run it by hand or from your own scheduler. It prints one line (`renewed`, `unchanged`, or the refusal) and exits 1 when refused or failed. Where keys are kept: `file:<path>`, `env-file:<path>#<NAME>`, `gcp:projects/<project>/secrets/<name>` (Google Secret Manager; a new version), `azure:https://<vault>.vault.azure.net/secrets/<name>` (Azure Key Vault), and `aws:<region>:<name>` or the secret's ARN (AWS Secrets Manager). Each uses the platform's own identity, or that cloud's CLI elsewhere. `kindgi doctor` gains a **License key** check: the key in `KINDGI_LICENSE_KEY` or this folder's `kindgi.env`, checked offline. From 30 days before it expires it warns, with the exact way to the next key (`kindgi license renew …`, or access.kindgi.com, or contact@kindgi.com for a key Kindgi issued). It also warns during the 14-day grace, and fails once the runtime would no longer start with it. With no key it skips (`kindgi dev` needs none). `--json` reports it as the check id `license`. Two new optional runtime settings, `KINDGI_LICENSE_KEY_REF` and `KINDGI_LICENSE_RENEWER_REF`, say where a deployment keeps its key and its renewer key, so the runtime's expiry warnings print the exact `kindgi license renew` command. The deployment modules set them.

## 0.1.7-rc.0

### Patch Changes

- b90e2c6: A deployment can renew its own license key, when you run it. `kindgi license enroll --for <your GitHub login> --renewer <where to keep its key>` makes the deployment's renewer key pair once. It keeps the private half where you say, never printing it, and prints a line to add on access.kindgi.com, signed in as that login. After that, `kindgi license renew --key <where the license key is> --renewer <ref>` (or `--env-file kindgi.env`) asks for the key's next version, checks it offline the way the runtime does (Kindgi's signature, the same licensee and use, expiring no earlier), and writes it only when it's new. Run it by hand or from your own scheduler. It prints one line (`renewed`, `unchanged`, or the refusal) and exits 1 when refused or failed. Where keys are kept: `file:<path>`, `env-file:<path>#<NAME>`, `gcp:projects/<project>/secrets/<name>` (Google Secret Manager; a new version), `azure:https://<vault>.vault.azure.net/secrets/<name>` (Azure Key Vault), and `aws:<region>:<name>` or the secret's ARN (AWS Secrets Manager). Each uses the platform's own identity, or that cloud's CLI elsewhere. `kindgi doctor` gains a **License key** check: the key in `KINDGI_LICENSE_KEY` or this folder's `kindgi.env`, checked offline. From 30 days before it expires it warns, with the exact way to the next key (`kindgi license renew …`, or access.kindgi.com, or contact@kindgi.com for a key Kindgi issued). It also warns during the 14-day grace, and fails once the runtime would no longer start with it. With no key it skips (`kindgi dev` needs none). `--json` reports it as the check id `license`. Two new optional runtime settings, `KINDGI_LICENSE_KEY_REF` and `KINDGI_LICENSE_RENEWER_REF`, say where a deployment keeps its key and its renewer key, so the runtime's expiry warnings print the exact `kindgi license renew` command. The deployment modules set them.

## 0.1.6

### Patch Changes

- fdb86ae: Reviewers can be told when an approval waits for them.
  
  - **`approval.requested` webhook event:** an endpoint can subscribe to it like `run.finished`.
    - **When:** sent each time an approval starts waiting (an escalation opens a new one).
    - **What:** `data.approval` carries `approvalId`, `projectId`, `requiredRole`, `title`, `assignedTo`, `createdAt`, `expiresAt` and `url`. Never what the approval is about: no `context`, tool call or run input.
    - **Filter:** the endpoint's `projectId` narrows it to the approval's project.
  - **`KINDGI_REVIEWER_EMAIL`** (off by default): `on` emails reviewers through the emailed sign-in link's server.
    - **Who:** the people the approvals list would show the approval to, only those who may read its project.
    - **How often:** the first email goes at once, then a five-minute digest.
    - **What:** title, project, required role and a link only.
    - **Without the server:** turned on without `KINDGI_AUTH_EMAIL_SMTP_URL` and `KINDGI_AUTH_EMAIL_FROM`, the runtime refuses to start.
  - **Clients:** the TypeScript and Python clients type the new event. The Python client's `parse_event` reads it.
- 8b9e90d: Azure settings for the runtime: `KINDGI_SECRETS_BACKEND_KMS=azure` with `KINDGI_SECRETS_AZURE_KEY_ID` (an Azure Key Vault key wraps the postgres backend's DEKs), `KINDGI_IMAGE_REGISTRY_AUTH=azure` (Azure Container Registry with the server's managed identity), and `KINDGI_AZURE_CLIENT_ID` (which user-assigned identity the server uses). `parseAzureKeyId` checks the key's URL and refuses one pinned to a version. `kindgi env init --kms=azure` writes them.
- 796c790: `KINDGI_SECRETS_AWS_REGION`, `KINDGI_SECRETS_AWS_KMS_KEY_ID` and `KINDGI_SECRETS_MANAGER=aws` say they're used from runtime 0.1.7: runtime 0.1.6 refuses `KINDGI_SECRETS_MANAGER=aws` at startup.
- 36c31ea: **The server's AWS identity, in the env schema** (group `aws`):
  - `KINDGI_AWS_IDENTITY`: `container`, `instance`, `web-identity` or `profile` (development only);
  - `KINDGI_AWS_PROFILE`;
  - `KINDGI_AWS_ROLE_ARN`, a role to assume, with `KINDGI_AWS_ROLE_SESSION_NAME` and `KINDGI_AWS_STS_REGION`.
  
  The runtime reads them from 0.1.7 on (0.1.6 ignores them), and then signs in to AWS only as they name, never with the AWS SDK's default chain.
- 5bdacf1: **Only the names a pack declares reach its code.** Before the pack's code loads, the pack service (TypeScript, Python, Java and Scala) drops from its environment every variable the pack doesn't declare in `env.required` or `env.optional`. A model key or a password in a self-hosted `--env-file`, meant for something else, no longer reaches a tool or a process a tool starts.
  
  - **What stays:** the declared names, `KINDGI_*`, and the platform's: the process's basics, the language runtime's settings, `PORT`, proxies and certificates, and Cloud Run's, AWS's and Azure's workload identity and metadata (`PLATFORM_ENV_NAMES`, `PLATFORM_ENV_PREFIXES`). Static credentials such as `AWS_SECRET_ACCESS_KEY` aren't the platform's: a pack that needs one declares it.
  - **What it says:** one `warn` record at start, `env-dropped`, with the names it dropped, never their values. A Python image always names `GPG_KEY`, which its base image sets.
  - **The opt-out:** `KINDGI_PACK_ENV_FILTER=off` keeps every variable, as before. `kindgi dev` sets it, since there the pack service gets the app's env files. Any value other than `on` or `off` is a `config-invalid` start.
  - **Java and Scala:** a JVM can't drop a variable from its own environment, so the launcher (`kindgi-pack-java`) does, keeping the names in `KINDGI_PACK_ENV_DECLARED`, which `kindgi build` now sets in the image from the pack's index. The service won't start while a variable the pack doesn't declare still reaches it, or when `KINDGI_PACK_ENV_DECLARED` isn't the index's `env`.
  - **The skills** (tools and getting-started, every language) say so: an undeclared name works under `kindgi dev` and is unset once deployed, so declare every name the code reads.
  - **The conformance suite** checks it for every pack service: an undeclared variable is absent in a tool, the declared ones and the platform's are there, and `off` keeps it.
- 26882a9: Retired export keys: after the export signing key rotates, the old public keys can stay listed, so an export signed before still verifies with `kindgi exports verify --from-runtime`.
  - **`@kindgi/crypto`:** `parseRetiredExportKeys(pemBundle)` reads one or more PEM public keys (Ed25519 or EC P-256), under the ids their signers use. A private key, another kind of block, an unreadable block or another kind of key is refused, naming the block's position. `withRetiredExportKeys(binding, keys)` lists them after the binding's own keys; the active key and `sign` stay the binding's, so a retired key never signs.
  - **`@kindgi/env-schema`:** `KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS_PATH` (a file of PEM public keys) and `KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS` (its base64), at most one. The runtime reads them; `GET /v1/export-signing-keys` then lists the retired keys after the active one, with `active: false`. Its response shape doesn't change.
- fdb86ae: Page cursors can be sealed. A list that hides rows the caller can't read after fetching them handed out its binding's cursor, a readable position that could name one of those rows (its id or time).
  
  - **What it does:** with `cursorSealer` (`createAeadCursorSealer`, AES-256-GCM), every list's cursors are sealed at the API's edge. A GET's sealed `cursor` opens to its position before any route reads it, and a JSON answer's `nextCursor` is sealed on its way out. A sealed cursor shows nothing of the row it points after.
  - **Where it opens:** only for the tenant, caller, list and filters it was handed out for, within a day. Otherwise `400 bad-input`, and the client starts again without it. The page size may change mid-scan. A plain cursor still passes.
  - **Keys:** each carries a `kid`. The first key seals and any listed key opens, so a key can rotate.
  - **Approvals:** with sealed cursors, `GET /v1/approvals` continues after the last approval it fetched once the page holds every one of that window the caller may read. A window of approvals the caller can't read no longer ends the paging: the page is empty, with `hasMore` and a cursor.
  - **Without a sealer:** cursors are the bindings' own, as before.
  - **The runtime's key:** `@kindgi/env-schema` lists `KINDGI_PAGINATION_KEY(_PATH)` and `KINDGI_PAGINATION_PREVIOUS_KEY(_PATH)` (for `--help` and the environment reference). Without a key, a cursor from before a restart answers 400 after it, and more than one instance needs the key. Keep the previous key at least a day after rotating, and rotate yearly. A cursor sealed with a key the runtime doesn't have says so (`unknown-key`). A list's filters bind as `[name, value]` pairs.
- 01958d4: The `secret-manager` secrets backend's settings: `KINDGI_SECRETS_MANAGER` (`azure`, `gcp` or `vault`; `aws` is read from runtime 0.1.7) picks your own secret manager, with `KINDGI_SECRETS_AZURE_VAULT_URL` (checked by `parseAzureVaultUrl`), `KINDGI_SECRETS_GCP_PROJECT_ID` (and, from runtime 0.1.7, `KINDGI_SECRETS_AWS_REGION`). `kindgi env init --secrets-backend=secret-manager --secrets-manager=<name>` writes them, and `--kms` is now for the `postgres` backend only. The secret-provider interface gains optional `providerVersion` fields, so Kindgi numbers secret versions itself whatever ids the provider uses.
- fdb86ae: An operator can manage sign-in alone. With `identityProviderChanges: 'operator'` (the runtime's `KINDGI_AUTH_TENANT_PROVIDERS=off`), a tenant can't add, change or remove its identity providers. `POST /v1/auth/providers`, `PATCH /v1/auth/providers/{providerId}` and `POST …/unregister` answer `403 identity-providers-operator-managed`: "This deployment's operator manages sign-in (KINDGI_AUTH_TENANT_PROVIDERS=off): identity providers can't be added, changed or removed here, except with the deployment's own token (KINDGI_API_TOKEN)." The deployment's own token (the `kindgi:system` capability) still can. Reading them is the same, and the providers there keep signing people in. `GET /v1/auth/providers` says which it is: an optional `changes`, `tenant` or `operator` (absent from older servers: read it as `tenant`). The TypeScript and Python clients read the new code as forbidden. `KINDGI_AUTH_TENANT_PROVIDERS` is in the environment schema (`on` by default).
- bbdccbb: An agent turn stops when its run is stopped. The runtime aborts a step's `abortSignal` when its run ends from outside: a cancel, or a shutdown that interrupts the runs it was executing. A turn's own work (its model call, its tool calls) listened only to the turn's abort, so a call in flight ran on until it answered.
  
  - **Now:** each step of a turn links the step's `abortSignal` to the turn's, so a call in flight is aborted at once, and the turn ends as aborted from outside (`agent-turn-aborted`, reason `external`).
  - **A wall-clock timeout keeps its own reason** (`timeout`).
  - **A cancelled turn's message stays plain:** `Agent turn cancelled`. The failure of the step its cancel aborted only restates the cancel, and is no longer appended as the turn's serialized failure. Any other words are kept.
  - **No API change.**
  - **`@kindgi/env-schema`** lists `KINDGI_RUN_ENDED_CHECK_MS`: how often a server stops the runs it executes that were ended from outside, so a step that writes nothing for a while, such as a long model call, stops within this time of a cancel. Default 5000 ms; at least 1000.

## 0.1.6-rc.0

### Patch Changes

- fdb86ae: Reviewers can be told when an approval waits for them.
  
  - **`approval.requested` webhook event:** an endpoint can subscribe to it like `run.finished`.
    - **When:** sent each time an approval starts waiting (an escalation opens a new one).
    - **What:** `data.approval` carries `approvalId`, `projectId`, `requiredRole`, `title`, `assignedTo`, `createdAt`, `expiresAt` and `url`. Never what the approval is about: no `context`, tool call or run input.
    - **Filter:** the endpoint's `projectId` narrows it to the approval's project.
  - **`KINDGI_REVIEWER_EMAIL`** (off by default): `on` emails reviewers through the emailed sign-in link's server.
    - **Who:** the people the approvals list would show the approval to, only those who may read its project.
    - **How often:** the first email goes at once, then a five-minute digest.
    - **What:** title, project, required role and a link only.
    - **Without the server:** turned on without `KINDGI_AUTH_EMAIL_SMTP_URL` and `KINDGI_AUTH_EMAIL_FROM`, the runtime refuses to start.
  - **Clients:** the TypeScript and Python clients type the new event. The Python client's `parse_event` reads it.
- 8b9e90d: Azure settings for the runtime: `KINDGI_SECRETS_BACKEND_KMS=azure` with `KINDGI_SECRETS_AZURE_KEY_ID` (an Azure Key Vault key wraps the postgres backend's DEKs), `KINDGI_IMAGE_REGISTRY_AUTH=azure` (Azure Container Registry with the server's managed identity), and `KINDGI_AZURE_CLIENT_ID` (which user-assigned identity the server uses). `parseAzureKeyId` checks the key's URL and refuses one pinned to a version. `kindgi env init --kms=azure` writes them.
- 796c790: `KINDGI_SECRETS_AWS_REGION`, `KINDGI_SECRETS_AWS_KMS_KEY_ID` and `KINDGI_SECRETS_MANAGER=aws` say they're used from runtime 0.1.7: runtime 0.1.6 refuses `KINDGI_SECRETS_MANAGER=aws` at startup.
- 36c31ea: **The server's AWS identity, in the env schema** (group `aws`):
  - `KINDGI_AWS_IDENTITY`: `container`, `instance`, `web-identity` or `profile` (development only);
  - `KINDGI_AWS_PROFILE`;
  - `KINDGI_AWS_ROLE_ARN`, a role to assume, with `KINDGI_AWS_ROLE_SESSION_NAME` and `KINDGI_AWS_STS_REGION`.
  
  The runtime reads them from 0.1.7 on (0.1.6 ignores them), and then signs in to AWS only as they name, never with the AWS SDK's default chain.
- 5bdacf1: **Only the names a pack declares reach its code.** Before the pack's code loads, the pack service (TypeScript, Python, Java and Scala) drops from its environment every variable the pack doesn't declare in `env.required` or `env.optional`. A model key or a password in a self-hosted `--env-file`, meant for something else, no longer reaches a tool or a process a tool starts.
  
  - **What stays:** the declared names, `KINDGI_*`, and the platform's: the process's basics, the language runtime's settings, `PORT`, proxies and certificates, and Cloud Run's, AWS's and Azure's workload identity and metadata (`PLATFORM_ENV_NAMES`, `PLATFORM_ENV_PREFIXES`). Static credentials such as `AWS_SECRET_ACCESS_KEY` aren't the platform's: a pack that needs one declares it.
  - **What it says:** one `warn` record at start, `env-dropped`, with the names it dropped, never their values. A Python image always names `GPG_KEY`, which its base image sets.
  - **The opt-out:** `KINDGI_PACK_ENV_FILTER=off` keeps every variable, as before. `kindgi dev` sets it, since there the pack service gets the app's env files. Any value other than `on` or `off` is a `config-invalid` start.
  - **Java and Scala:** a JVM can't drop a variable from its own environment, so the launcher (`kindgi-pack-java`) does, keeping the names in `KINDGI_PACK_ENV_DECLARED`, which `kindgi build` now sets in the image from the pack's index. The service won't start while a variable the pack doesn't declare still reaches it, or when `KINDGI_PACK_ENV_DECLARED` isn't the index's `env`.
  - **The skills** (tools and getting-started, every language) say so: an undeclared name works under `kindgi dev` and is unset once deployed, so declare every name the code reads.
  - **The conformance suite** checks it for every pack service: an undeclared variable is absent in a tool, the declared ones and the platform's are there, and `off` keeps it.
- 26882a9: Retired export keys: after the export signing key rotates, the old public keys can stay listed, so an export signed before still verifies with `kindgi exports verify --from-runtime`.
  - **`@kindgi/crypto`:** `parseRetiredExportKeys(pemBundle)` reads one or more PEM public keys (Ed25519 or EC P-256), under the ids their signers use. A private key, another kind of block, an unreadable block or another kind of key is refused, naming the block's position. `withRetiredExportKeys(binding, keys)` lists them after the binding's own keys; the active key and `sign` stay the binding's, so a retired key never signs.
  - **`@kindgi/env-schema`:** `KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS_PATH` (a file of PEM public keys) and `KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS` (its base64), at most one. The runtime reads them; `GET /v1/export-signing-keys` then lists the retired keys after the active one, with `active: false`. Its response shape doesn't change.
- fdb86ae: Page cursors can be sealed. A list that hides rows the caller can't read after fetching them handed out its binding's cursor, a readable position that could name one of those rows (its id or time).
  
  - **What it does:** with `cursorSealer` (`createAeadCursorSealer`, AES-256-GCM), every list's cursors are sealed at the API's edge. A GET's sealed `cursor` opens to its position before any route reads it, and a JSON answer's `nextCursor` is sealed on its way out. A sealed cursor shows nothing of the row it points after.
  - **Where it opens:** only for the tenant, caller, list and filters it was handed out for, within a day. Otherwise `400 bad-input`, and the client starts again without it. The page size may change mid-scan. A plain cursor still passes.
  - **Keys:** each carries a `kid`. The first key seals and any listed key opens, so a key can rotate.
  - **Approvals:** with sealed cursors, `GET /v1/approvals` continues after the last approval it fetched once the page holds every one of that window the caller may read. A window of approvals the caller can't read no longer ends the paging: the page is empty, with `hasMore` and a cursor.
  - **Without a sealer:** cursors are the bindings' own, as before.
  - **The runtime's key:** `@kindgi/env-schema` lists `KINDGI_PAGINATION_KEY(_PATH)` and `KINDGI_PAGINATION_PREVIOUS_KEY(_PATH)` (for `--help` and the environment reference). Without a key, a cursor from before a restart answers 400 after it, and more than one instance needs the key. Keep the previous key at least a day after rotating, and rotate yearly. A cursor sealed with a key the runtime doesn't have says so (`unknown-key`). A list's filters bind as `[name, value]` pairs.
- 01958d4: The `secret-manager` secrets backend's settings: `KINDGI_SECRETS_MANAGER` (`azure`, `gcp` or `vault`; `aws` is read from runtime 0.1.7) picks your own secret manager, with `KINDGI_SECRETS_AZURE_VAULT_URL` (checked by `parseAzureVaultUrl`), `KINDGI_SECRETS_GCP_PROJECT_ID` (and, from runtime 0.1.7, `KINDGI_SECRETS_AWS_REGION`). `kindgi env init --secrets-backend=secret-manager --secrets-manager=<name>` writes them, and `--kms` is now for the `postgres` backend only. The secret-provider interface gains optional `providerVersion` fields, so Kindgi numbers secret versions itself whatever ids the provider uses.
- fdb86ae: An operator can manage sign-in alone. With `identityProviderChanges: 'operator'` (the runtime's `KINDGI_AUTH_TENANT_PROVIDERS=off`), a tenant can't add, change or remove its identity providers. `POST /v1/auth/providers`, `PATCH /v1/auth/providers/{providerId}` and `POST …/unregister` answer `403 identity-providers-operator-managed`: "This deployment's operator manages sign-in (KINDGI_AUTH_TENANT_PROVIDERS=off): identity providers can't be added, changed or removed here, except with the deployment's own token (KINDGI_API_TOKEN)." The deployment's own token (the `kindgi:system` capability) still can. Reading them is the same, and the providers there keep signing people in. `GET /v1/auth/providers` says which it is: an optional `changes`, `tenant` or `operator` (absent from older servers: read it as `tenant`). The TypeScript and Python clients read the new code as forbidden. `KINDGI_AUTH_TENANT_PROVIDERS` is in the environment schema (`on` by default).
- bbdccbb: An agent turn stops when its run is stopped. The runtime aborts a step's `abortSignal` when its run ends from outside: a cancel, or a shutdown that interrupts the runs it was executing. A turn's own work (its model call, its tool calls) listened only to the turn's abort, so a call in flight ran on until it answered.
  
  - **Now:** each step of a turn links the step's `abortSignal` to the turn's, so a call in flight is aborted at once, and the turn ends as aborted from outside (`agent-turn-aborted`, reason `external`).
  - **A wall-clock timeout keeps its own reason** (`timeout`).
  - **A cancelled turn's message stays plain:** `Agent turn cancelled`. The failure of the step its cancel aborted only restates the cancel, and is no longer appended as the turn's serialized failure. Any other words are kept.
  - **No API change.**
  - **`@kindgi/env-schema`** lists `KINDGI_RUN_ENDED_CHECK_MS`: how often a server stops the runs it executes that were ended from outside, so a step that writes nothing for a while, such as a long model call, stops within this time of a cancel. Default 5000 ms; at least 1000.

## 0.1.5

### Patch Changes

- 490d083: Artifacts belong to a project, and the capability catalog says what each feature means and which of your models have it.
  - **Artifacts (`/v1/artifacts`):**
    - Every artifact belongs to a project: its owner run's, else the upload's new `projectId`, else the tenant's default project. `BlobMeta` carries `projectId` and `createdBy`, and `BlobPutInput` takes them (both optional).
    - With authorization on, listing and downloading need `read` on that project, and uploading and deleting need `write`.
      - An artifact the caller can't read is `404`, as if absent.
      - A list shows only what the caller can read. `?projectId=` narrows it.
    - An upload naming an owner run that doesn't exist is `404 run-not-found`. A `projectId` that isn't the owner run's project is `400`.
    - The runtime caps an upload: `413 artifact-too-large`, with `details.maxBytes`. `CreateAppInput.artifactMaxBytes` sets it (default 100 MB).
  - **Retention domain `artifact`:** a retention policy can purge deleted artifacts after its grace.
  - **Capabilities:**
    - `FEATURE_DESCRIPTIONS` (`@kindgi/capabilities`) says in a line what each of the 13 features means.
    - A `CapabilityDescriptor` may carry `providers: [{providerId, models}]`, the tenant's providers with a model that has the feature (optional in the spec).
  - **TypeScript client:**
    - `artifacts.upload` (multipart), `download` (streamed bytes) and `head`; `list` takes `projectId`.
    - `put` and `get` (content-addressed `BlobRef`s) have no API route: they throw, pointing to `upload` and `download`.
    - `artifact-too-large` is an invalid request.
  - **Python client:** the new fields; a 413 is an `InvalidRequestError`.
  - **Runtime settings (`@kindgi/env-schema`):**
    - `KINDGI_ARTIFACTS` is `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`; it turns on `/v1/artifacts`.
    - `KINDGI_ARTIFACT_MAX_BYTES` sets the upload cap.
    - `kindgi dev` sets artifacts to the pack's `.kindgi/dev/artifacts`, which is gitignored.
  - **CLI:**
    - `kindgi artifacts list|get|upload|download|delete` and `kindgi capabilities list|get` work; before, they were hidden.
    - `artifacts head` is folded into `get`.
- f19bc64: **Upgrading: signing in to the console with an API token is now off by default, except in `kindgi dev`.** If people sign in to your console by pasting an API token, set `KINDGI_CONSOLE_TOKEN_SIGN_IN=on` on the runtime when you upgrade, or set up sign-in with your organization's identity provider. Otherwise the console's sign-in page offers no way in. API tokens keep working for the API, the CLI and the SDKs either way. `kindgi doctor` now warns when nobody can sign in to the console of the runtime it points at.
  
  - **`POST /v1/auth/token-sign-in`**: the API token in `Authorization` is exchanged once for a browser session in the session cookie (HttpOnly, the same as sign-in with an identity provider), so the browser never keeps the token. Only a person's full key opens a session: a service account's key, or a narrowed one (a `member` role, or one project), is refused 403 `token-sign-in-not-allowed`. The session ends after its lifetime, or when the key expires if sooner. 403 `token-sign-in-off` when the deployment doesn't allow it. TypeScript `client.auth.tokenSignIn()`. Enabled by `SessionConfig.tokenSignIn`; audited as `signed-in` (method `api-token`).
  - **`POST /v1/auth/logout`** is mounted with browser sessions even without identity providers, so a console signed in with a token can sign out.
  - **`GET /v1/auth/sign-in-options`** gains `methods: { identityProviders, apiToken }` (optional: absent from older servers), and is mounted whenever there's a way in, with or without identity providers.
  - **`SessionCookieOptions.sameOrigin`**: also accept a cookie request whose `Origin` names the host it was sent to (`Host`, or `X-Forwarded-Host`), for a deployment that doesn't know its public URL. The console is served by the runtime itself, and a cross-site page can't forge `Origin`.
  - **`KINDGI_CONSOLE_TOKEN_SIGN_IN`** (`@kindgi/env-schema`): `on` or `off`; default `off`, and `on` in `kindgi dev`.
  - **`kindgi doctor`**: a "Console sign-in" check for the runtime the CLI points at (`--url`, `KINDGI_API_URL`, `kindgi auth login`). It warns when token sign-in is off and no identity provider is set up, or none is registered, naming the setting that fixes it.
- b67c599: Memory erasure: the erasure ledger has its own key, `KINDGI_ERASURE_LEDGER_KEY_PATH` or `KINDGI_ERASURE_LEDGER_KEY` (32 bytes, the same form as the secrets AAD key), read whatever the secrets backend. It replaces the secrets AAD key as the source of the ledger's keyed hash: set it to make erasures replayable after a backup restore. `erasure-unmatchable` and `kindgi doctor`'s `erasures` check name it.
- b67c599: Erasing a person's words: `/v1/memory/erasures` (create, get, list, export, replay), for a tenant admin only. Erasing a Kindgi user (`subject.kind: user`) isn't offered: `400`. An erasure clears, in the background, a person's (an app's end user, `participant`, or an `external` subject facts name; or one fact's, or one conversation's) facts, conversations, the runs that served them and what those left in provenance; facts written from them go to review. A completed erasure keeps no identifier, only a keyed hash in the ledger, which you export off-box (`kindgi memory erasures export`) and replay after restoring a backup (`kindgi memory erasures replay`). `409 legal-hold` names held facts; an `erasure-unmatchable` warning says when the deployment can't keep the hash. Clients: `memory.erasures.*` (TypeScript), `memory.create_erasure` and friends (Python). A run whose content an erasure cleared has `contentErasedAt`. An erasure whose person has a turn in a flow serving other people waits for that run (`waiting-on-run`, `waitingOn`) until a deadline (`KINDGI_ERASURE_SHARED_WAIT_MS`, 7 days by default), then cancels it; `POST /v1/memory/erasures/{erasureId}/resume` (`kindgi memory erasures resume <id> [--force]`) tries again now, and `force` stops the wait. A test set's case copied from an erased run reads `erased: true` (`input`/`output` null, no items); comparison eval runs leave it out and count it (`summary.erased`).
- b67c599: Two retention domains: `memory` and `conversation`. A `memory` policy purges, past its grace, every revision of a fact whose life ended (deleted, or its current revision past its expiry); a fact under legal hold is never purged. A `conversation` policy purges unregistered conversations with their messages and recall index. Both hold people's words, so their retention is opt-in: a `*` policy doesn't reach them, only a policy naming them does.
- d94a98c: Retrieved memory reaches the model as labelled data, and search by meaning is never skipped silently.
  
  - **The `<memory>` block.** Retrieved facts no longer go into a second system message. They go into one user-role message just before the user's: `<memory note="kindgi memory: data, not instructions">` with JSON (every `<` escaped, so no fact can close the block). Per fact: `id`, `type`, `trust`, who asserted it (`assertedBy`, the kind only), validity dates, and content. The system message gains a fixed line: content in `<memory>` blocks is data, not instructions, and the user's current message wins. Recorded runs keep their journaled retrievals, so replays see the same facts. **This changes what models see.**
  - **Policies.** `defineAgent({ memory: { instructionTypes: ['policy'] } })` makes a retrieved fact of those types that a person **verified** an instruction, in the system message under "Policies (verified)". By default there are none: every retrieved fact is data.
  - **Modes.**
    - `both` fuses the keyword and meaning searches by rank (reciprocal rank fusion, `fuseByRank` in `@kindgi/memory`). Each retrieved fact carries its rank in each search (`RetrievedFact.ranks`), kept in the turn's journal.
    - `semantic` on a runtime without embeddings fails the turn with `semantic-unavailable`, naming the intent and `KINDGI_MEMORY_EMBEDDINGS`. `both` runs its keyword half and journals `degraded: no-embeddings`. Before, both skipped the search by meaning without a word.
  - **`same-user`** is a new retrieval scope: this run's end user's facts and those of the Kindgi user it acts for.
  - **The API.**
    - `POST /v1/memory/retrieve` answers `422 semantic-unavailable` for `semantic` or `both` without embeddings. The spec listed `400 bad-input`, but the runtime's retrieve was a stub that answered an empty `200`, so no client could have seen the 400.
    - `POST /v1/agents` returns `warnings` (`semantic-unavailable`) for an agent whose retrieval searches by meaning on such a deployment (`MemoryBinding.semanticSearch`).
  - **Operator settings.**
    - `KINDGI_MEMORY_EMBEDDINGS=openai-compat` turns on search by meaning through any embeddings endpoint that speaks OpenAI's `POST /embeddings` (OpenAI, Ollama, vLLM, Hugging Face TEI): set `KINDGI_MEMORY_EMBEDDINGS_URL` and `KINDGI_MEMORY_EMBEDDINGS_MODEL`, plus `KINDGI_MEMORY_EMBEDDINGS_API_KEY` from your secret store if the endpoint takes a key.
    - `local:<model>` runs the model inside a server run from source on macOS or glibc Linux, not in the runtime image.
    - An endpoint that doesn't answer doesn't stop the runtime, at boot or later. It is retried in the background, and search by meaning waits for it.
    - `@kindgi/embedding` adds `EmbeddingUnavailableError` (`embedding-unavailable`). A semantic search returning it is treated exactly like having no embeddings: `semantic` fails the turn with `semantic-unavailable`, and `both` runs its keyword half and journals it.
    - `@kindgi/adapter-model-openai-compat` adds `createOpenAICompatEmbeddingProvider`. Its `probe()` embeds once, to learn the dimensions.
  - **Specs and SDKs.**
    - The agent spec (schema-version 1.4.0) and pack index carry `memory` and the `same-user` scope; both indexers, TS and Python (`Agent(memory=...)`), keep them.
    - CLI: `kindgi memory facts retrieve --query=<json>` is wired.
- d898f33: `KINDGI_SEED_USER_ID`'s description says what a runtime from 0.1.5 does without it. The API token's user is kept across restarts while `KINDGI_API_TOKEN` stays the same, and a changed token gets a new user, with a warning at boot. Before, a new user came at every boot. Set it to keep one user across token changes.
- 646a906: **Signed exports work end to end: one export key, one envelope, and a verifier.** An approval's audit bundle, a run's provenance and compliance evidence are signed with the deployment's export key.
  
  - **The key:** `createApp({ exportSigning })` takes an `ExportSigningBinding` (`@kindgi/crypto`: async, so a KMS can back it; `createEd25519ExportSigner` for a key file). Key ids are derived from the public key (`ex_…`). The old `signingKey` still works, deprecated. On the runtime: `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` (base64 PEM, for Secret Manager) or the optional `KINDGI_EXPORT_SIGNING_KMS_KEY`; `kindgi dev` passes a key file through, or the runtime makes one.
  - **Two algorithms, chosen per key:** an Ed25519 key signs `ed25519` (the default); an EC P-256 key signs `ecdsa-p256-sha256`, for a key store without Ed25519 (a Cloud KMS `EC_SIGN_P256_SHA256` key, say). Its signature is IEEE P1363 `r‖s`. `createExportSignerFromPem` reads the algorithm from the key; `ecdsaDerToP1363` converts a KMS's DER signature. Both verifiers check either, and refuse an algorithm they don't know, naming it. Shared test vectors for both are in `@kindgi/specs` (`test-vectors/signed-export/`).
  - **One envelope:** the signed bytes (`bundle`), the signature, the public key, an optional `kind`, and `exportedAt`, which is now signed and the same in the envelope. Body versions: the audit bundle is `2.0.0` (a string; it was the integer `1`), provenance `1.2.0` (adds the signed `exportedAt`), compliance `1.0.0`.
  - **No body needed:** `signingKeyId` is optional (the active key), and an empty body reads as `{}`. **Behaviour change:** a `POST` to one of the three exports with no body, or without `signingKeyId`, used to answer `400 bad-input`; it now signs with the active key.
  - **Each export is recorded** as an `export-signed` audit event (who, what, which key, the SHA-256 of the signed bytes). An export whose record can't be written isn't handed out.
  - **`GET /v1/export-signing-keys`** lists the public keys to pin; `exportSigningKeys.list()` in the TS client.
  - **Verify:** `verifySignedExport` in `@kindgi/client` and `@kindgi/sdk/client` (Web Crypto); `approvals.audit.verify`, `provenance.verify` and `compliance.evidence.verify` now work. Python: `kindgi.exports.verify_signed_export` (`pip install 'kindgi[verify]'`). CLI: `kindgi exports verify <file> [--trust=<pem>] [--from-runtime]`.
  - **CLI:** `kindgi approvals export <approval-id>`; `kindgi provenance export`'s `--signing-key` is optional.
  - **Compliance:** `collectEvidence` builds an export's records, so the generator's `exportSigned` is optional and deprecated.
  - **Specs:** `signed-export.schema.json` (the envelope), and `audit-bundle.schema.json` 2.0.0 describes the bundle the API exports.
  - **Cloud Run module:** `export_signing = "secret" | "kms"` (opt-in).
- 7f55890: New runtime settings for "Continue with Google / Microsoft / GitHub" with the deployment's own apps: `KINDGI_AUTH_GOOGLE_CLIENT_ID` and `KINDGI_AUTH_GOOGLE_CLIENT_SECRET` (or `…_SECRET_PATH`), and the same for `MICROSOFT` and `GITHUB`. People who've been added to a workspace sign in with that account, by its verified email. Google and Microsoft speak for a company's email only through the company's own accounts (a Google Workspace account of that domain, a Microsoft work account): a personal account made on a work address is refused. A Microsoft app needs the ID-token optional claims `email` and `xms_edov`; without `xms_edov`, Microsoft sign-ins are refused. On the domains of a workspace that signs its people in with its own identity provider, GitHub and the emailed link are not offered or accepted.
- 7a85bf6: New runtime settings for the emailed sign-in link: `KINDGI_AUTH_EMAIL_SMTP_URL` (or `…_PATH`) and `KINDGI_AUTH_EMAIL_FROM` turn it on. People who've been added to a workspace can then ask for a one-time link by email, valid for ten minutes. `KINDGI_AUTH_TURNSTILE_SECRET` (or `…_PATH`) with `KINDGI_AUTH_TURNSTILE_SITE_KEY` puts a Cloudflare Turnstile check on asking for one: optional on a runtime that serves one tenant, and required on one that serves several. Links to one address are limited: one a minute, 3 per 15 minutes (except for the browser that already got one), and `KINDGI_AUTH_EMAIL_LINK_DAILY_CAP` (default 20) a day from one client network.
- 66bab49: Sign-in contract for identity providers and browser sessions.
  
  - **Identity providers, one shape per `kind`.** `ProviderConfig` is a union: `oidc` (an OpenID Connect identity provider: `issuer` + `clientId` + `clientSecretRef`, endpoints from discovery), `saml` (IdP metadata XML, or entity ID + SSO URL + certificates; `spSigningKeyRef` / `spDecryptionKeyRef` by reference), and `oauth2` (a plain OAuth 2.0 provider that isn't OpenID Connect, e.g. GitHub: the old shape). All kinds gain `displayName`, `domains`, `join` and `signIn`. A `clientSecret` or raw key in the body is refused (400 `invalid-provider-config`), and the deployment may refuse a configuration it can't use (422 `identity-provider-invalid`). **TypeScript: narrow on `kind` before reading kind-specific fields** (`config.tokenEndpoint` needs `config.kind === 'oauth2'`, or `'oidc'` with endpoints).
  - **`GET /v1/auth/sign-in-options?email=`** (unauthenticated): the providers for the email's domain, each with a `signInUrl`. Sign-in is email first: with no email the list is empty, and the binding isn't asked. The same answer for anyone at a domain; rate-limited per client (429 `rate-limit-exceeded`). TypeScript `client.auth.signInOptions({ email })`. Backed by the optional `IdentityProviderBinding.signInOptions`.
  - **Browser sessions in a cookie** (`SessionConfig.cookie`): the session token is read from `__Host-kindgi_session` when there's no `Authorization` header; a cookie-authenticated unsafe request needs an allowed `Origin` (403 `csrf-origin-mismatch`, a missing `Origin` too). Logout clears the cookie; refresh of a cookie session is refused (400 `cookie-session-not-refreshable`).
  - **The provider catalog, refresh and logout mount without `exchangeCode`**; only this API's own OAuth flow (`/v1/auth/login` + callback) needs it.
  - **For `SessionStoreBinding` implementers:** `SessionCreateInput.accessToken` and `Session.accessToken` are optional (a deployment may keep no identity-provider tokens). Copy them conditionally.
  - **Runtime settings for sign-in** (`@kindgi/env-schema`): `KINDGI_AUTH_SECRET_PATH` / `KINDGI_AUTH_SECRET` (turn sign-in with identity providers on; need `KINDGI_PUBLIC_URL`), `KINDGI_AUTH_PRIVATE_IDP_ORIGINS` (private-network identity providers the operator allows), `KINDGI_SESSION_TTL_MS` (default 12 hours) and `KINDGI_SESSION_IDLE_TIMEOUT_MS` (default 60 minutes).
- 6dc2637: Sign-in finds a person's identity provider by their email's domain only once that domain is verified for a tenant. A runtime that serves one tenant routes that tenant's domains, as before. One that serves several routes a domain only once its operator lists it in the new `KINDGI_AUTH_VERIFIED_DOMAINS` (`acme.com:<tenant>`). Otherwise a tenant could list another company's domain and catch its people. `kindgi sso providers test` says so when a domain isn't routed.
- 280377e: **A tool's env values, per project (`ctx.env`).** A tool that declares names in `needsSpec.env` gets their values in `ctx.env` on each call: the call's project's value, else its org's, else the tenant's, in the env the runtime serves (`KINDGI_ENV`). A schema `default` makes a name optional. The values a call used are recorded with it (`ToolContext.record`, new: the step's durable record, set by the dispatch site), so the call re-run after a wait or a retry sees the same ones. A runtime that resolves them is needed; with an older one, `ctx.env` stays absent.
  
  - **`@kindgi/tools`:** `ToolContext.env`; `ToolContext.record`, which an agent turn's tool dispatch (`@kindgi/agents`) sets to its step's record under `tool-call:<call id>:<tool id>:<key>`; and `TypedNeeds` documents what `env` and `secrets` take (strings, checked by their schema; `config` is reserved).
  - **Pack protocol 2.5.0** (`@kindgi/specs`, `@kindgi/handler-runtime`, the Python SDK): `callContext.env` holds the declared names' string values. It's additive: a pack service that predates it already passes it through.
  - **`kindgi env set/list/unset --scope=tenant|org:<id>|project:<id> --env=<name>`** act on the runtime's env values (`/v1/env`). Without `--scope` they edit the pack's local env files, as before. `--env` is required with `--scope`. `set` refuses to change a value without `--force`, and warns about a name that looks like a credential. A runtime that doesn't serve `/v1/env` gets a plain message.
  - `kindgi env`'s description now says what it manages. It used to say values "resolve into `needs.env` at deploy time", which nothing did.
- 7a85bf6: New runtime setting `KINDGI_TRUSTED_PROXIES`: which proxies in front of the runtime to trust for a client's address, used by rate limits and audit records. Unset, the address is the connection's peer and `X-Forwarded-For` is ignored. Behind a load balancer or ingress, set a hop count (`1`) or your proxies' IPs/CIDR ranges. The client is then the first `X-Forwarded-For` hop from the right that isn't a trusted proxy, never the leftmost on its own. The sign-in options rate limit no longer keys on the leftmost `X-Forwarded-For` address, which a client can spoof: by default it uses the nearest hop.

## 0.1.5-rc.0

### Patch Changes

- 490d083: Artifacts belong to a project, and the capability catalog says what each feature means and which of your models have it.
  - **Artifacts (`/v1/artifacts`):**
    - Every artifact belongs to a project: its owner run's, else the upload's new `projectId`, else the tenant's default project. `BlobMeta` carries `projectId` and `createdBy`, and `BlobPutInput` takes them (both optional).
    - With authorization on, listing and downloading need `read` on that project, and uploading and deleting need `write`.
      - An artifact the caller can't read is `404`, as if absent.
      - A list shows only what the caller can read. `?projectId=` narrows it.
    - An upload naming an owner run that doesn't exist is `404 run-not-found`. A `projectId` that isn't the owner run's project is `400`.
    - The runtime caps an upload: `413 artifact-too-large`, with `details.maxBytes`. `CreateAppInput.artifactMaxBytes` sets it (default 100 MB).
  - **Retention domain `artifact`:** a retention policy can purge deleted artifacts after its grace.
  - **Capabilities:**
    - `FEATURE_DESCRIPTIONS` (`@kindgi/capabilities`) says in a line what each of the 13 features means.
    - A `CapabilityDescriptor` may carry `providers: [{providerId, models}]`, the tenant's providers with a model that has the feature (optional in the spec).
  - **TypeScript client:**
    - `artifacts.upload` (multipart), `download` (streamed bytes) and `head`; `list` takes `projectId`.
    - `put` and `get` (content-addressed `BlobRef`s) have no API route: they throw, pointing to `upload` and `download`.
    - `artifact-too-large` is an invalid request.
  - **Python client:** the new fields; a 413 is an `InvalidRequestError`.
  - **Runtime settings (`@kindgi/env-schema`):**
    - `KINDGI_ARTIFACTS` is `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`; it turns on `/v1/artifacts`.
    - `KINDGI_ARTIFACT_MAX_BYTES` sets the upload cap.
    - `kindgi dev` sets artifacts to the pack's `.kindgi/dev/artifacts`, which is gitignored.
  - **CLI:**
    - `kindgi artifacts list|get|upload|download|delete` and `kindgi capabilities list|get` work; before, they were hidden.
    - `artifacts head` is folded into `get`.
- f19bc64: **Upgrading: signing in to the console with an API token is now off by default, except in `kindgi dev`.** If people sign in to your console by pasting an API token, set `KINDGI_CONSOLE_TOKEN_SIGN_IN=on` on the runtime when you upgrade, or set up sign-in with your organization's identity provider. Otherwise the console's sign-in page offers no way in. API tokens keep working for the API, the CLI and the SDKs either way. `kindgi doctor` now warns when nobody can sign in to the console of the runtime it points at.
  
  - **`POST /v1/auth/token-sign-in`**: the API token in `Authorization` is exchanged once for a browser session in the session cookie (HttpOnly, the same as sign-in with an identity provider), so the browser never keeps the token. Only a person's full key opens a session: a service account's key, or a narrowed one (a `member` role, or one project), is refused 403 `token-sign-in-not-allowed`. The session ends after its lifetime, or when the key expires if sooner. 403 `token-sign-in-off` when the deployment doesn't allow it. TypeScript `client.auth.tokenSignIn()`. Enabled by `SessionConfig.tokenSignIn`; audited as `signed-in` (method `api-token`).
  - **`POST /v1/auth/logout`** is mounted with browser sessions even without identity providers, so a console signed in with a token can sign out.
  - **`GET /v1/auth/sign-in-options`** gains `methods: { identityProviders, apiToken }` (optional: absent from older servers), and is mounted whenever there's a way in, with or without identity providers.
  - **`SessionCookieOptions.sameOrigin`**: also accept a cookie request whose `Origin` names the host it was sent to (`Host`, or `X-Forwarded-Host`), for a deployment that doesn't know its public URL. The console is served by the runtime itself, and a cross-site page can't forge `Origin`.
  - **`KINDGI_CONSOLE_TOKEN_SIGN_IN`** (`@kindgi/env-schema`): `on` or `off`; default `off`, and `on` in `kindgi dev`.
  - **`kindgi doctor`**: a "Console sign-in" check for the runtime the CLI points at (`--url`, `KINDGI_API_URL`, `kindgi auth login`). It warns when token sign-in is off and no identity provider is set up, or none is registered, naming the setting that fixes it.
- b67c599: Memory erasure: the erasure ledger has its own key, `KINDGI_ERASURE_LEDGER_KEY_PATH` or `KINDGI_ERASURE_LEDGER_KEY` (32 bytes, the same form as the secrets AAD key), read whatever the secrets backend. It replaces the secrets AAD key as the source of the ledger's keyed hash: set it to make erasures replayable after a backup restore. `erasure-unmatchable` and `kindgi doctor`'s `erasures` check name it.
- b67c599: Erasing a person's words: `/v1/memory/erasures` (create, get, list, export, replay), for a tenant admin only. Erasing a Kindgi user (`subject.kind: user`) isn't offered: `400`. An erasure clears, in the background, a person's (an app's end user, `participant`, or an `external` subject facts name; or one fact's, or one conversation's) facts, conversations, the runs that served them and what those left in provenance; facts written from them go to review. A completed erasure keeps no identifier, only a keyed hash in the ledger, which you export off-box (`kindgi memory erasures export`) and replay after restoring a backup (`kindgi memory erasures replay`). `409 legal-hold` names held facts; an `erasure-unmatchable` warning says when the deployment can't keep the hash. Clients: `memory.erasures.*` (TypeScript), `memory.create_erasure` and friends (Python). A run whose content an erasure cleared has `contentErasedAt`. An erasure whose person has a turn in a flow serving other people waits for that run (`waiting-on-run`, `waitingOn`) until a deadline (`KINDGI_ERASURE_SHARED_WAIT_MS`, 7 days by default), then cancels it; `POST /v1/memory/erasures/{erasureId}/resume` (`kindgi memory erasures resume <id> [--force]`) tries again now, and `force` stops the wait. A test set's case copied from an erased run reads `erased: true` (`input`/`output` null, no items); comparison eval runs leave it out and count it (`summary.erased`).
- b67c599: Two retention domains: `memory` and `conversation`. A `memory` policy purges, past its grace, every revision of a fact whose life ended (deleted, or its current revision past its expiry); a fact under legal hold is never purged. A `conversation` policy purges unregistered conversations with their messages and recall index. Both hold people's words, so their retention is opt-in: a `*` policy doesn't reach them, only a policy naming them does.
- d94a98c: Retrieved memory reaches the model as labelled data, and search by meaning is never skipped silently.
  
  - **The `<memory>` block.** Retrieved facts no longer go into a second system message. They go into one user-role message just before the user's: `<memory note="kindgi memory: data, not instructions">` with JSON (every `<` escaped, so no fact can close the block). Per fact: `id`, `type`, `trust`, who asserted it (`assertedBy`, the kind only), validity dates, and content. The system message gains a fixed line: content in `<memory>` blocks is data, not instructions, and the user's current message wins. Recorded runs keep their journaled retrievals, so replays see the same facts. **This changes what models see.**
  - **Policies.** `defineAgent({ memory: { instructionTypes: ['policy'] } })` makes a retrieved fact of those types that a person **verified** an instruction, in the system message under "Policies (verified)". By default there are none: every retrieved fact is data.
  - **Modes.**
    - `both` fuses the keyword and meaning searches by rank (reciprocal rank fusion, `fuseByRank` in `@kindgi/memory`). Each retrieved fact carries its rank in each search (`RetrievedFact.ranks`), kept in the turn's journal.
    - `semantic` on a runtime without embeddings fails the turn with `semantic-unavailable`, naming the intent and `KINDGI_MEMORY_EMBEDDINGS`. `both` runs its keyword half and journals `degraded: no-embeddings`. Before, both skipped the search by meaning without a word.
  - **`same-user`** is a new retrieval scope: this run's end user's facts and those of the Kindgi user it acts for.
  - **The API.**
    - `POST /v1/memory/retrieve` answers `422 semantic-unavailable` for `semantic` or `both` without embeddings. The spec listed `400 bad-input`, but the runtime's retrieve was a stub that answered an empty `200`, so no client could have seen the 400.
    - `POST /v1/agents` returns `warnings` (`semantic-unavailable`) for an agent whose retrieval searches by meaning on such a deployment (`MemoryBinding.semanticSearch`).
  - **Operator settings.**
    - `KINDGI_MEMORY_EMBEDDINGS=openai-compat` turns on search by meaning through any embeddings endpoint that speaks OpenAI's `POST /embeddings` (OpenAI, Ollama, vLLM, Hugging Face TEI): set `KINDGI_MEMORY_EMBEDDINGS_URL` and `KINDGI_MEMORY_EMBEDDINGS_MODEL`, plus `KINDGI_MEMORY_EMBEDDINGS_API_KEY` from your secret store if the endpoint takes a key.
    - `local:<model>` runs the model inside a server run from source on macOS or glibc Linux, not in the runtime image.
    - An endpoint that doesn't answer doesn't stop the runtime, at boot or later. It is retried in the background, and search by meaning waits for it.
    - `@kindgi/embedding` adds `EmbeddingUnavailableError` (`embedding-unavailable`). A semantic search returning it is treated exactly like having no embeddings: `semantic` fails the turn with `semantic-unavailable`, and `both` runs its keyword half and journals it.
    - `@kindgi/adapter-model-openai-compat` adds `createOpenAICompatEmbeddingProvider`. Its `probe()` embeds once, to learn the dimensions.
  - **Specs and SDKs.**
    - The agent spec (schema-version 1.4.0) and pack index carry `memory` and the `same-user` scope; both indexers, TS and Python (`Agent(memory=...)`), keep them.
    - CLI: `kindgi memory facts retrieve --query=<json>` is wired.
- d898f33: `KINDGI_SEED_USER_ID`'s description says what a runtime from 0.1.5 does without it. The API token's user is kept across restarts while `KINDGI_API_TOKEN` stays the same, and a changed token gets a new user, with a warning at boot. Before, a new user came at every boot. Set it to keep one user across token changes.
- 646a906: **Signed exports work end to end: one export key, one envelope, and a verifier.** An approval's audit bundle, a run's provenance and compliance evidence are signed with the deployment's export key.
  
  - **The key:** `createApp({ exportSigning })` takes an `ExportSigningBinding` (`@kindgi/crypto`: async, so a KMS can back it; `createEd25519ExportSigner` for a key file). Key ids are derived from the public key (`ex_…`). The old `signingKey` still works, deprecated. On the runtime: `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` (base64 PEM, for Secret Manager) or the optional `KINDGI_EXPORT_SIGNING_KMS_KEY`; `kindgi dev` passes a key file through, or the runtime makes one.
  - **Two algorithms, chosen per key:** an Ed25519 key signs `ed25519` (the default); an EC P-256 key signs `ecdsa-p256-sha256`, for a key store without Ed25519 (a Cloud KMS `EC_SIGN_P256_SHA256` key, say). Its signature is IEEE P1363 `r‖s`. `createExportSignerFromPem` reads the algorithm from the key; `ecdsaDerToP1363` converts a KMS's DER signature. Both verifiers check either, and refuse an algorithm they don't know, naming it. Shared test vectors for both are in `@kindgi/specs` (`test-vectors/signed-export/`).
  - **One envelope:** the signed bytes (`bundle`), the signature, the public key, an optional `kind`, and `exportedAt`, which is now signed and the same in the envelope. Body versions: the audit bundle is `2.0.0` (a string; it was the integer `1`), provenance `1.2.0` (adds the signed `exportedAt`), compliance `1.0.0`.
  - **No body needed:** `signingKeyId` is optional (the active key), and an empty body reads as `{}`. **Behaviour change:** a `POST` to one of the three exports with no body, or without `signingKeyId`, used to answer `400 bad-input`; it now signs with the active key.
  - **Each export is recorded** as an `export-signed` audit event (who, what, which key, the SHA-256 of the signed bytes). An export whose record can't be written isn't handed out.
  - **`GET /v1/export-signing-keys`** lists the public keys to pin; `exportSigningKeys.list()` in the TS client.
  - **Verify:** `verifySignedExport` in `@kindgi/client` and `@kindgi/sdk/client` (Web Crypto); `approvals.audit.verify`, `provenance.verify` and `compliance.evidence.verify` now work. Python: `kindgi.exports.verify_signed_export` (`pip install 'kindgi[verify]'`). CLI: `kindgi exports verify <file> [--trust=<pem>] [--from-runtime]`.
  - **CLI:** `kindgi approvals export <approval-id>`; `kindgi provenance export`'s `--signing-key` is optional.
  - **Compliance:** `collectEvidence` builds an export's records, so the generator's `exportSigned` is optional and deprecated.
  - **Specs:** `signed-export.schema.json` (the envelope), and `audit-bundle.schema.json` 2.0.0 describes the bundle the API exports.
  - **Cloud Run module:** `export_signing = "secret" | "kms"` (opt-in).
- 7f55890: New runtime settings for "Continue with Google / Microsoft / GitHub" with the deployment's own apps: `KINDGI_AUTH_GOOGLE_CLIENT_ID` and `KINDGI_AUTH_GOOGLE_CLIENT_SECRET` (or `…_SECRET_PATH`), and the same for `MICROSOFT` and `GITHUB`. People who've been added to a workspace sign in with that account, by its verified email. Google and Microsoft speak for a company's email only through the company's own accounts (a Google Workspace account of that domain, a Microsoft work account): a personal account made on a work address is refused. A Microsoft app needs the ID-token optional claims `email` and `xms_edov`; without `xms_edov`, Microsoft sign-ins are refused. On the domains of a workspace that signs its people in with its own identity provider, GitHub and the emailed link are not offered or accepted.
- 7a85bf6: New runtime settings for the emailed sign-in link: `KINDGI_AUTH_EMAIL_SMTP_URL` (or `…_PATH`) and `KINDGI_AUTH_EMAIL_FROM` turn it on. People who've been added to a workspace can then ask for a one-time link by email, valid for ten minutes. `KINDGI_AUTH_TURNSTILE_SECRET` (or `…_PATH`) with `KINDGI_AUTH_TURNSTILE_SITE_KEY` puts a Cloudflare Turnstile check on asking for one: optional on a runtime that serves one tenant, and required on one that serves several. Links to one address are limited: one a minute, 3 per 15 minutes (except for the browser that already got one), and `KINDGI_AUTH_EMAIL_LINK_DAILY_CAP` (default 20) a day from one client network.
- 66bab49: Sign-in contract for identity providers and browser sessions.
  
  - **Identity providers, one shape per `kind`.** `ProviderConfig` is a union: `oidc` (an OpenID Connect identity provider: `issuer` + `clientId` + `clientSecretRef`, endpoints from discovery), `saml` (IdP metadata XML, or entity ID + SSO URL + certificates; `spSigningKeyRef` / `spDecryptionKeyRef` by reference), and `oauth2` (a plain OAuth 2.0 provider that isn't OpenID Connect, e.g. GitHub: the old shape). All kinds gain `displayName`, `domains`, `join` and `signIn`. A `clientSecret` or raw key in the body is refused (400 `invalid-provider-config`), and the deployment may refuse a configuration it can't use (422 `identity-provider-invalid`). **TypeScript: narrow on `kind` before reading kind-specific fields** (`config.tokenEndpoint` needs `config.kind === 'oauth2'`, or `'oidc'` with endpoints).
  - **`GET /v1/auth/sign-in-options?email=`** (unauthenticated): the providers for the email's domain, each with a `signInUrl`. Sign-in is email first: with no email the list is empty, and the binding isn't asked. The same answer for anyone at a domain; rate-limited per client (429 `rate-limit-exceeded`). TypeScript `client.auth.signInOptions({ email })`. Backed by the optional `IdentityProviderBinding.signInOptions`.
  - **Browser sessions in a cookie** (`SessionConfig.cookie`): the session token is read from `__Host-kindgi_session` when there's no `Authorization` header; a cookie-authenticated unsafe request needs an allowed `Origin` (403 `csrf-origin-mismatch`, a missing `Origin` too). Logout clears the cookie; refresh of a cookie session is refused (400 `cookie-session-not-refreshable`).
  - **The provider catalog, refresh and logout mount without `exchangeCode`**; only this API's own OAuth flow (`/v1/auth/login` + callback) needs it.
  - **For `SessionStoreBinding` implementers:** `SessionCreateInput.accessToken` and `Session.accessToken` are optional (a deployment may keep no identity-provider tokens). Copy them conditionally.
  - **Runtime settings for sign-in** (`@kindgi/env-schema`): `KINDGI_AUTH_SECRET_PATH` / `KINDGI_AUTH_SECRET` (turn sign-in with identity providers on; need `KINDGI_PUBLIC_URL`), `KINDGI_AUTH_PRIVATE_IDP_ORIGINS` (private-network identity providers the operator allows), `KINDGI_SESSION_TTL_MS` (default 12 hours) and `KINDGI_SESSION_IDLE_TIMEOUT_MS` (default 60 minutes).
- 6dc2637: Sign-in finds a person's identity provider by their email's domain only once that domain is verified for a tenant. A runtime that serves one tenant routes that tenant's domains, as before. One that serves several routes a domain only once its operator lists it in the new `KINDGI_AUTH_VERIFIED_DOMAINS` (`acme.com:<tenant>`). Otherwise a tenant could list another company's domain and catch its people. `kindgi sso providers test` says so when a domain isn't routed.
- 280377e: **A tool's env values, per project (`ctx.env`).** A tool that declares names in `needsSpec.env` gets their values in `ctx.env` on each call: the call's project's value, else its org's, else the tenant's, in the env the runtime serves (`KINDGI_ENV`). A schema `default` makes a name optional. The values a call used are recorded with it (`ToolContext.record`, new: the step's durable record, set by the dispatch site), so the call re-run after a wait or a retry sees the same ones. A runtime that resolves them is needed; with an older one, `ctx.env` stays absent.
  
  - **`@kindgi/tools`:** `ToolContext.env`; `ToolContext.record`, which an agent turn's tool dispatch (`@kindgi/agents`) sets to its step's record under `tool-call:<call id>:<tool id>:<key>`; and `TypedNeeds` documents what `env` and `secrets` take (strings, checked by their schema; `config` is reserved).
  - **Pack protocol 2.5.0** (`@kindgi/specs`, `@kindgi/handler-runtime`, the Python SDK): `callContext.env` holds the declared names' string values. It's additive: a pack service that predates it already passes it through.
  - **`kindgi env set/list/unset --scope=tenant|org:<id>|project:<id> --env=<name>`** act on the runtime's env values (`/v1/env`). Without `--scope` they edit the pack's local env files, as before. `--env` is required with `--scope`. `set` refuses to change a value without `--force`, and warns about a name that looks like a credential. A runtime that doesn't serve `/v1/env` gets a plain message.
  - `kindgi env`'s description now says what it manages. It used to say values "resolve into `needs.env` at deploy time", which nothing did.
- 7a85bf6: New runtime setting `KINDGI_TRUSTED_PROXIES`: which proxies in front of the runtime to trust for a client's address, used by rate limits and audit records. Unset, the address is the connection's peer and `X-Forwarded-For` is ignored. Behind a load balancer or ingress, set a hop count (`1`) or your proxies' IPs/CIDR ranges. The client is then the first `X-Forwarded-For` hop from the right that isn't a trusted proxy, never the leftmost on its own. The sign-in options rate limit no longer keys on the leftmost `X-Forwarded-For` address, which a client can spoof: by default it uses the nearest hop.

## 0.1.4

### Patch Changes

- 149a8c9: **`KINDGI_COMPLIANCE_CLASSIFIER` turns on the audit trail's compliance features**, off by default. Set it to `shipped` (the classifier the runtime ships) or to the absolute path of your own classifier JSON. When set, the runtime serves `/v1/compliance/*` and **purges audit events by kind, as the classifier says**.
  
  With `shipped`:
  
  | Audit events | Purged after |
  |---|---|
  | Authorization decisions | 90 days |
  | Authorization denials | 365 days |
  | Run outcomes and guardrail violations | 730 days |
  | Secret changes and approval decisions | never (legal hold) |
  | Kinds the classifier doesn't list | never |
  
  Unset: no `/v1/compliance/*`, and no audit event is ever purged.
  
  `AuditEventPurgeInput` gains optional `outcome` / `exceptOutcome`, so a kind's denials can be kept longer than the rest (a classifier's `onDenyDays`). The in-memory binding honors both.
- 846dd9c: `KINDGI_RUN_LEASE_MS` and `KINDGI_RUN_SWEEP_INTERVAL_MS` say they cover eval runs too: a running eval run holds the same executor lease, and when its server stops without a shutdown, the sweep ends it `failed`, interrupted, with its finished cases kept.
- c0f1b56: `KINDGI_PUBLIC_URL`: the URL clients reach the runtime at, when it isn't the address the server binds (behind a proxy, or a container whose port is published on another one). The runtime's startup banner names it, with its docs and console links. `kindgi dev` sets it, so the banner shows the port `kindgi dev` chose, e.g. 4001 when 4000 was taken, not the container's 4000. `parsePublicUrl` validates it; a runtime that doesn't read it keeps working.
- 9801f64: **Request logs and trace context.**
  
  - **`createApp({ logger })`** takes a `@kindgi/log` logger. Without one, the app stays quiet.
    - Each request gets `c.var.log`, with subsystem `http` and its `requestId`, `traceId` and `spanId` (plus `tenantId` once authenticated), and `c.var.trace`.
    - An incoming `traceparent` is honoured, with a new span; a missing or malformed one starts a fresh trace. Every response answers `traceresponse`.
  - **The access line:** `METHOD /v1/runs/:runId 200 12ms`, with the route's pattern and never the raw path.
    - Writes and 4xx are logged at `info`, 5xx at `error`.
    - Successful reads, probes and stream openings are logged at `debug`, so `info` stays readable while a console polls.
    - A 500 also logs the error itself, redacted.
  - **Runs carry their trace.** Starting a run hands the request's trace to the run handler (`RunTrace` on the agent and flow invoke inputs). `RunFlowInput`, `StartRunParams` and `KernelRunRecord` take an optional `traceId`. `Run.traceId` is on the wire when a run has one: optional in the TypeScript client, `trace_id` in the Python client.
  - **Pack protocol 2.4.1:** the optional `traceparent` request header (`PACK_HEADERS.traceparent`), so a pack service's records can carry the run's trace id.
  - **`KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`** are in the env schema, for the runtime server. Under `auto`, the format is pretty on a terminal or with `KINDGI_DEV=true`.
  - **`kindgi dev`** runs the runtime with pretty logs (`KINDGI_LOG_FORMAT=pretty`) and keeps only its last 200 lines in memory.
- 7c084e1: New server setting `KINDGI_RETENTION_SWEEP_INTERVAL_MS`, off by default: when set, the runtime purges deleted rows on its own on that interval, in every tenant it serves. It purges the tombstones past their retention policy's grace, as `POST /v1/retention/sweep` does, keeps holds (`graceSeconds: -1`), and logs what it purged. Unset, nothing purges on its own, as before. At least 60000 (one minute).

## 0.1.4-rc.5

### Patch Changes

- 9801f64: **Request logs and trace context.**
  
  - **`createApp({ logger })`** takes a `@kindgi/log` logger. Without one, the app stays quiet.
    - Each request gets `c.var.log`, with subsystem `http` and its `requestId`, `traceId` and `spanId` (plus `tenantId` once authenticated), and `c.var.trace`.
    - An incoming `traceparent` is honoured, with a new span; a missing or malformed one starts a fresh trace. Every response answers `traceresponse`.
  - **The access line:** `METHOD /v1/runs/:runId 200 12ms`, with the route's pattern and never the raw path.
    - Writes and 4xx are logged at `info`, 5xx at `error`.
    - Successful reads, probes and stream openings are logged at `debug`, so `info` stays readable while a console polls.
    - A 500 also logs the error itself, redacted.
  - **Runs carry their trace.** Starting a run hands the request's trace to the run handler (`RunTrace` on the agent and flow invoke inputs). `RunFlowInput`, `StartRunParams` and `KernelRunRecord` take an optional `traceId`. `Run.traceId` is on the wire when a run has one: optional in the TypeScript client, `trace_id` in the Python client.
  - **Pack protocol 2.4.1:** the optional `traceparent` request header (`PACK_HEADERS.traceparent`), so a pack service's records can carry the run's trace id.
  - **`KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`** are in the env schema, for the runtime server. Under `auto`, the format is pretty on a terminal or with `KINDGI_DEV=true`.
  - **`kindgi dev`** runs the runtime with pretty logs (`KINDGI_LOG_FORMAT=pretty`) and keeps only its last 200 lines in memory.

## 0.1.4-rc.4

No changes in this release.

## 0.1.4-rc.3

No changes in this release.

## 0.1.4-rc.2

### Patch Changes

- 149a8c9: **`KINDGI_COMPLIANCE_CLASSIFIER` turns on the audit trail's compliance features**, off by default. Set it to `shipped` (the classifier the runtime ships) or to the absolute path of your own classifier JSON. When set, the runtime serves `/v1/compliance/*` and **purges audit events by kind, as the classifier says**.
  
  With `shipped`:
  
  | Audit events | Purged after |
  |---|---|
  | Authorization decisions | 90 days |
  | Authorization denials | 365 days |
  | Run outcomes and guardrail violations | 730 days |
  | Secret changes and approval decisions | never (legal hold) |
  | Kinds the classifier doesn't list | never |
  
  Unset: no `/v1/compliance/*`, and no audit event is ever purged.
  
  `AuditEventPurgeInput` gains optional `outcome` / `exceptOutcome`, so a kind's denials can be kept longer than the rest (a classifier's `onDenyDays`). The in-memory binding honors both.
- 7c084e1: New server setting `KINDGI_RETENTION_SWEEP_INTERVAL_MS`, off by default: when set, the runtime purges deleted rows on its own on that interval, in every tenant it serves. It purges the tombstones past their retention policy's grace, as `POST /v1/retention/sweep` does, keeps holds (`graceSeconds: -1`), and logs what it purged. Unset, nothing purges on its own, as before. At least 60000 (one minute).

## 0.1.4-rc.1

### Patch Changes

- 846dd9c: `KINDGI_RUN_LEASE_MS` and `KINDGI_RUN_SWEEP_INTERVAL_MS` say they cover eval runs too: a running eval run holds the same executor lease, and when its server stops without a shutdown, the sweep ends it `failed`, interrupted, with its finished cases kept.
- c0f1b56: `KINDGI_PUBLIC_URL`: the URL clients reach the runtime at, when it isn't the address the server binds (behind a proxy, or a container whose port is published on another one). The runtime's startup banner names it, with its docs and console links. `kindgi dev` sets it, so the banner shows the port `kindgi dev` chose, e.g. 4001 when 4000 was taken, not the container's 4000. `parsePublicUrl` validates it; a runtime that doesn't read it keeps working.

## 0.1.4-rc.0

No changes in this release.

## 0.1.3

### Patch Changes

- 4ed3d2f: CLI fixes from a pilot's feedback, and the runtime's port order.
  
  - **`kindgi runs start` never loses the run.** It starts the run in the background and follows it, rather than holding the start request open. A long agent turn no longer times out the CLI with no run id to look it up by. It still waits until the run finishes or waits on an approval, and prints the same record. A stopped wait (Ctrl+C) prints `Stopped waiting. Run <id> goes on: kindgi runs get <id>`.
  - **The Gemini preset uses the models' real output limit:** 65,536 tokens for Gemini 2.5 Pro and Flash, thinking included. It used to cap Pro at 8192. `kindgi providers register --preset=<name> --max-output-tokens=<n>` sets another cap.
  - **`kindgi env plan --format=gcloud` emits `--update-env-vars` / `--update-secrets`.** They add or replace the names listed and leave the service's other variables alone. `--set-*` replaced the whole env.
  - **`KINDGI_API_PORT`'s description states the port order.** The runtime takes the first that's set: the `--port` flag, `KINDGI_API_PORT`, the platform's `PORT` (Cloud Run, Render, Heroku and Fly set it), the config file's `port`, then 4000.
- 2c185d8: Fixes from the first Cloud Run deployment.
  
  - **The pack service token is read the same way on both sides.** `parsePackServiceToken` (new in `@kindgi/env-schema`) drops surrounding whitespace, so a secret stored with a trailing newline no longer makes every pack call answer 401. A token with whitespace or a control character inside is refused at startup, since an HTTP header can't carry it. The Node pack service and the Python one (`kindgi.pack.serve`) both use the rule, and the pack conformance suite checks it.
  - **Refusals aren't replayed.** The idempotency middleware stores a response only when the request took effect (a status below 400). A request retried with the same `Idempotency-Key` after a refusal (4xx) or a failure (5xx) runs again, so a deploy retried after trusting its key now goes through.
  - **`kindgi deploy` says when an answer is a replay** (`X-Idempotent-Replay`) and how to retry: `--idempotency-key <new value>` for a replayed refusal from an older runtime. A refused signing key's hint gives the `kindgi key trust <keyId> --url <endpoint>` command on a line of its own. The retry advice for server errors and network failures is reworded.
- 66e7ac2: `KINDGI_WEBHOOK_PRIVATE_NETWORKS` (`allow` | `deny`, default `deny`): a self-hosted runtime's webhooks may go to a receiver on its own private network, at an RFC 1918, CGNAT (100.64.0.0/10) or IPv6 unique-local address. Loopback, link-local (the cloud metadata endpoints) and unroutable addresses stay refused, and webhooks stay https only. The runtime reads it from 0.1.3.

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- fde369b: The local key for secrets (`KINDGI_SECRETS_BACKEND_KMS=libsodium`): `KINDGI_SECRETS_LOCAL_KEY_PATH` or `KINDGI_SECRETS_LOCAL_KEY`, and `KINDGI_SECRETS_LOCAL_KEY_ACK` (required, exactly `single-node`). A self-hosted runtime without a cloud KMS can keep secrets in Postgres with a key it holds; `KINDGI_SECRETS_BACKEND_KMS` lists `libsodium` as supported.

## 0.1.1

### Patch Changes

- d00fc1b: **The executor lease's timings, for operators.** The runtime fails a run whose server stopped without a shutdown (killed, out of memory, a crash) once the run's lease runs out, and sends `run.finished`. Two `core` variables set how fast:
  
  - `KINDGI_RUN_LEASE_MS`: how long a run's lease lasts without renewal (default 300000, 5 minutes; at least 10000). The server executing the run renews it every quarter of this.
  - `KINDGI_RUN_SWEEP_INTERVAL_MS`: how often each server sweeps for runs whose lease ran out (default 60000; at least 1000, and shorter than the lease).
  
  Out-of-range values stop the server at startup. Such a run is failed within about a lease plus one sweep.

## 0.1.0

### Minor Changes

- aec851d: A deployment's tools and guardrails keep where their code is, and the trust list it's verified against gets routes.
  
  - **`@kindgi/api`, `POST /v1/deployments`:**
    - **What registers is the signed image's index.** The server reads `/app/index.json` from the image, checks it hashes to the signed `indexHash`, and registers what it declares. The request body no longer carries `index`. Before, the route validated and registered the body's copy, which no signature covers, so a replayed request could register tools the image never shipped. The image's index must also name the signed `artifactVersion` (`400 image-unverifiable` otherwise).
    - **The code pointer.** A tool's `modulePath` and a guardrail's `checkModulePath` become `codeArtifactRef: { kind: 'oci', imageRef, modulePath, artifactVersion }`, pointing into the deployed image. Before, they were stripped, so a deployed pack tool had no code the runtime could reach.
    - **What a deployment shipped.** The record gains `contents`: each tool's, agent's and flow's `{ id, version }`, and each guardrail's `{ id }`. `DeploymentRegisterInput` and `Deployment` carry it; it's required, so a `DeploymentBinding` stores it. Versions are immutable and a digest deploys once, so the latest deployment is the live one. A rollback rolls forward: deploy the earlier code again under new versions.
    - **The catalog caches hear of it.** A new deployment calls `onToolWrite` / `onGuardrailWrite` for each tool and guardrail it registered, as `POST /v1/tools` and `POST /v1/guardrails` do, so a runtime's tool and guardrail bridges see it at once. `DeploymentContents` and `DeployedPrimitive` are exported.
    - **Indexed guardrails deploy.** A guardrail's `checkId` becomes its `check`, and the index-only `configSchema` is dropped, as `kindgi dev` maps them. Before, every guardrail the indexer writes failed validation.
  - **`@kindgi/api`, `/v1/signing-keys`:** the tenant's trusted signing keys, the public keys whose deployments verify. Mounted when `signingKeyRegistry` is passed, on its own, without the deployments route.
    - `POST /v1/signing-keys` trusts a key: `keyId`, `publicKey` (base64 Ed25519), `label?`. It returns `201`, or `200` for the same key again. A known id with another key is `409 signing-key-conflict`; rotate under a new id.
    - `GET /v1/signing-keys` lists the active keys (`?includeRevoked=true`, `?label=` prefix). `GET /v1/signing-keys/{keyId}` returns one key, revoked or not.
    - `POST /v1/signing-keys/{keyId}/revoke` takes an optional `reason`. A revoked key stays readable for audit and verifies no new deployments.
    - Writes need the `signing-keys:write` capability.
    - Revocation is final: trusting a revoked key id again is `409 signing-key-revoked`.
    - New error codes: `signing-key-conflict` (409), `signing-key-revoked` (409), `signing-key-algorithm-unsupported` (400), `signing-key-store-error` (500).
  - **`@kindgi/client`:** `client.signingKeys` (`trust`, `list`, `get`, `revoke`); `deployments.register` takes no `index`. The Python client's models and resources follow.
  - **`@kindgi/env-schema`:** the `image-registry` group, how the server reads deployment images: `KINDGI_IMAGE_REGISTRY_HOST`, `_USERNAME`, `_PASSWORD` (credentials for one host, all three or none) and `_INSECURE_HOSTS` (hosts reached over plain HTTP).
- aec851d: `KINDGI_DEV_HOST_ALIAS` (development only): where the server's outbound calls to a loopback address connect instead. Inside a container, loopback is the container itself, so webhooks to the app, HTTP MCP endpoints, a model provider and the pack service on the developer's machine would all miss. `kindgi dev` sets `host.docker.internal` on Docker Desktop. The URL, the `Host` header and the TLS server name stay as written; only the connection goes to the alias.
- aec851d: The server binary's development settings, so `kindgi dev` can run the runtime as a container:
  
  - `KINDGI_API_HOST` (core): the address the API server binds. Default: all interfaces. `127.0.0.1` keeps it off the network.
  - `KINDGI_PACK_DIR` (development only): the pack directory `kindgi dev` runs. The server reads the pack's primitives from the index `kindgi dev` writes there (`.kindgi/dev/index.json`) instead of from Postgres, and signed deployments are off.
  - `KINDGI_DEV_CONSOLE_LOGIN` (development only): the console logs in by itself through `GET /__dev/bearer`, which answers loopback hosts only.
  
  The development settings form a new `dev` group, listed last in `.env.example`. `KINDGI_DEV`'s description now names them.
- aec851d: `KINDGI_LICENSE_KEY`: the commercial license key (`kgi_lk_...`) the server checks offline at startup outside development mode. Without a valid key, a server that isn't in development mode refuses to start; `KINDGI_DEV=true` needs none. `LICENSE_KEY_VAR` names it.
- aec851d: `parseCorsOrigins`, `CORS_ORIGINS_VAR` and `PUBLIC_TOKEN_KEY_PATH_VAR`: the check for `KINDGI_CORS_ORIGINS` (exact origins: a scheme, a host and an optional port; no path or wildcard), so the server and the CLI refuse the same values with the same message.
- aec851d: A pack declares the process environment its code reads, and the pack service says what's missing.
  
  - **`kindgi.config`** takes `env: { required?, optional? }`: the names the pack's code reads from `process.env`. The indexer validates them (environment variable names, no `KINDGI_*`, no name twice) and writes them, sorted, into `index.json` as `env`, which is absent when nothing is declared. A malformed declaration fails indexing as `config-invalid`. `resolvePackEnv` and `missingPackEnv` are exported for tools that check the same thing.
  - **The pack service**, with a required name unset or empty, isn't ready: `/readyz` and every call answer 503 `{ "error": "missing env", "missingEnv": [...] }`, names only. `/v1/info` always lists `missingEnv`, and the names are logged once at startup (`missing-env`). `KINDGI_PACK_ENV_CHECK=warn` serves anyway; anything other than `strict` (the default) or `warn` fails startup.
  - **`@kindgi/specs`:** `pack-index.schema.json` 1.4.0 adds the optional `env`; `pack-protocol.schema.json` 2.2.0 adds the optional `missingEnv` to `info`. The Python SDK's vendored copies match.
  - **`@kindgi/env-schema`:** `KINDGI_PACK_ENV_CHECK` (component `pack-service`).
  - **`@kindgi/pack-conformance`:** cases for the declared env, and `unsupported` on a target, which skips the cases for a part of the contract it hasn't implemented yet.
  - **The `kindgi-authoring-tools` skill** says to declare the names a tool reads.
- aec851d: The pack service's variables, and the server's for reaching it.
  
  - **The `component` axis.** `EnvTarget.component` is `server` (the default) or `pack-service`, the separate process that runs a pack's code. The server's vars don't apply to the pack service's target.
  - **The `packTransport` axis.** `EnvTarget.packTransport: 'http'` is set when the server calls a pack service at `KINDGI_PACK_SERVICE_URL`. Its token is then required.
  - **New vars,** in a new `pack-service` group:
    - `KINDGI_PACK_SERVICE_URL`: the server's address for the pack service. Unset, no pack code runs.
    - `KINDGI_PACK_SERVICE_TOKEN`: the secret shared by the server and the pack service. Required by the pack service, and by the server with an HTTP pack transport.
    - `KINDGI_PACK_CALL_TIMEOUT_MS`: how long one pack call may take (default 120000).
    - `KINDGI_PACK_INDEX` and `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`: the pack service's index path (default `/app/index.json`) and call cap (default 32). The pack service already reads both; they're declared here now.
- aec851d: What a server on Cloud Run needs to reach its pack service and images, and to take its keys without files:
  
  - `KINDGI_PACK_SERVICE_AUTH`: `token` (default) | `google-id-token`, which also sends a Google ID token for an IAM-protected pack service.
  - `KINDGI_IMAGE_REGISTRY_AUTH`: `static` (default, the username and password) | `google`, the server's own Google identity for Artifact Registry.
  - `KINDGI_SECRETS_AAD_KEY` and `KINDGI_PUBLIC_TOKEN_SIGNING_KEY`: the key material itself, base64, as the alternative to the `_PATH` variables (one or the other, not both) for platforms that give secrets as environment variables. `KINDGI_SECRETS_AAD_KEY_PATH` is no longer required on its own: the postgres backend needs one of the two. `PUBLIC_TOKEN_KEY_VAR` names the new signing-key variable.
- aec851d: What a tenant registers can no longer reach the server's own host unless the deployment allows it, and MCP endpoints authenticate through the secrets store.
  
  - **`KINDGI_TENANT_HOST_ACCESS`** (`@kindgi/env-schema`): `deployed` refuses a `stdio` MCP endpoint, a command the server would run in its container as its user. `local` allows it, for a machine where every token holder may run commands. Unset, it's `local` under `KINDGI_DEV` and `deployed` otherwise.
  - **`@kindgi/api`:**
    - `createApp` takes `tenantHostAccess` (default `deployed`). Under `deployed`, registering a `stdio` endpoint answers `403 host-access-denied`, a new error code.
    - `deniesHostReach`, `parseTenantHostAccess`, `TENANT_HOST_ACCESS_LEVELS` and `stdioRefusal` are exported for the runtime's connect-time check. Checks ask `deniesHostReach(level, reach)`, so a stricter level is one more row.
    - `mcpRouter` takes the level as a fourth argument.
  - **`MCPEndpoint.secretRef: { envName, name }` replaces `authRef`.** It's a secret by name in the deployment's store, resolved at the endpoint's tenant scope, the shape webhooks and providers use.
    - `env:NAME` references, which read the server's own environment, are gone.
    - The register body now refuses unknown fields, so an `authRef` is a `400` (`unknown-field`), not silently dropped.
    - The webhook routes and MCP share one `secretRef` parser.
  - **`@kindgi/client`:** `McpEndpoint` and `RegisterMcpEndpointInput` take `secretRef` (`McpEndpointSecretRef`). The Python `kindgi.client` is regenerated: `secret_ref` replaces `auth_ref`.
- aec851d: Tool secrets reach the tools that declare them.
  
  - `@kindgi/env-schema`: `KINDGI_ENV`, the env a runtime serves. Secrets a tool declares by name (`needsSpec.secrets`) resolve under it; development mode defaults it to `local`.
  - `@kindgi/handler-runtime`: the indexer carries a declarative tool's `spec` (`defineTool({ spec })`) into `index.json`, so the runtime runs the tool itself and resolves its `secretRef`s, instead of the pack service running it without them.
  - `@kindgi/specs`: `pack-index.schema.json` 1.2.0 adds a tool's optional `spec`. The Python SDK's vendored copy matches.
  - `@kindgi/sdk`: the `kindgi-python-authoring-tools` skill — and the Python SDK's README and `ToolContext.secrets` docstring — say how to declare a secret (`needs_spec={"secrets": …}`) and read it from `ctx.secrets`; `ctx.env` and `ctx.config` are still empty.
- aec851d: `KINDGI_DEV` (development mode; boolean like `KINDGI_DOCS`) and the `dotenv` secrets backend: `KINDGI_SECRETS_BACKEND=dotenv` reads and writes `.env` files in `KINDGI_SECRETS_DOTENV_DIR` (required), optionally narrowed by `KINDGI_SECRETS_DOTENV_FILES` (default `.env,.env.local`). `EnvTarget.secretsBackend` accepts `dotenv`. The server allows the `dotenv` backend only in development mode.
- aec851d: Kindgi inside an existing app: project-local configuration, the app's own env files, nothing leaks.
  
  - **BREAKING — `@kindgi/env-schema`:** the runtime reads only `KINDGI_*` names. `DATABASE_URL` → `KINDGI_DATABASE_URL`, `OPENFGA_API_URL` → `KINDGI_OPENFGA_API_URL`, with no fallback; every unprefixed name belongs to the agents.
  - **`@kindgi/dotenv-file`:** parses the dotenv format the way applications do (verified against `dotenv@16.3.1`), adds `${VAR}` expansion (agrees with dotenv-expand 10 and 12 where they agree) and layered reading. The writer keeps hand-written lines byte for byte and refuses values it can't write back unchanged.
  - **`@kindgi/handler-runtime`:** `loadKindgiConfig` — one loader for `kindgi.config.*` (including `.mts` for CommonJS hosts) that reports a broken config's cause; `resolveDiscovery` walks only each discovery pattern's fixed prefix instead of the whole host repo.
  - **`@kindgi/secrets-dotenv`:** one resolver for a pack's env files (`.env` < `.env.local`, or `dev.envFiles`). `KINDGI_*` names never resolve as secrets, dev writes go only to `.env.local`, and warnings name `file:line`, never the line itself.
  - **`@kindgi/sdk`:** authoring skills updated (a handler with nothing to `await` can return `Promise.resolve`).
- aec851d: Public run tokens: a browser can follow a run's progress without a secret API token.
  
  - `@kindgi/api`:
    - `CreateAppInput.publicRunTokens` (`signingKey` + `keyId`, an Ed25519 key; lifetimes; `allowedOrigins`). When set, `POST /v1/runs` returns `publicAccessToken` + `publicAccessTokenExpiresAt` (15 minutes by default), and `POST /v1/tokens/public` mints tokens for up to 50 runs (at most 24 hours).
    - Progress routes: `GET /v1/runs/{runId}/progress` (`RunProgress`: status and timing, no input, output or failure message) and `GET /v1/runs/{runId}/progress/stream` (`RunProgressEvent`: kind, node, sequence, time; no payload). They accept an API token or a public run token. `GET /v1/runs/{runId}` and `/stream` are unchanged and keep requiring an API token.
    - A public run token (`kgi_pt_…`, Ed25519-signed, stateless) is accepted only by the two progress routes (every other route answers 403), for the runs it names and their descendants (others answer 404).
    - The routes a public token may use come from the operation registry (`security: 'bearer-or-public-run'`); the OpenAPI document declares the `publicRunToken` security scheme on them.
    - CORS for `allowedOrigins` on the two progress routes only, ahead of authentication.
    - `mintPublicRunToken` / `verifyPublicRunToken` for deployments that issue tokens themselves.
  - `@kindgi/client`:
    - `subscribeToRun({ apiUrl, runId, accessToken, refreshAccessToken })`: follow a run's progress from a browser with a public token, refreshing it when it expires.
    - `runs.progress`, `runs.streamProgress`, `tokens.createPublic`.
    - `runs.stream` now follows the run to its terminal event: when the server ends the stream at its time limit, it reconnects from the last event instead of ending early. `followRun` is the shared loop; `readSse` takes `lastEventId` and per-attempt `headers`, and throws `SseHttpError` (with `status`) on HTTP errors.
  - `@kindgi/env-schema`: `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` and `KINDGI_CORS_ORIGINS`.

### Patch Changes

- aec851d: The hooks the runtime needs to guard the server's connections to hosts a tenant chose (T83). The guard itself is in the runtime.
  
  - **`@kindgi/api`:** `HostReach` gains `'metadata-network'` (link-local addresses, where the cloud metadata endpoints hand out the server's credentials) and `'loopback'` (the server's own host). `KINDGI_TENANT_HOST_ACCESS=deployed` refuses both, as well as `'exec'`.
  - **`@kindgi/capabilities`:** `AdapterFactoryInput.fetch` is the fetch for a provider endpoint the registration chose.
  - **`@kindgi/adapter-model-openai-compat`:** the factory sends through that fetch.
  - **`@kindgi/tools`:**
    - `defineTool(spec, { synthesizer: { fetch } })` and `ToolSpecSynthesizerOptions`: a declarative HTTP tool's handler sends through the runtime's fetch.
    - `validateToolManifest` now refuses an HTTP tool whose `urlTemplate` puts a `{placeholder}` in the scheme, host or port, or isn't `http(s)://` with a host. Placeholders belong in the path and query, where they're URL-encoded; in the authority, a run's input would pick the host.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS`'s description says what `deployed` refuses.
- aec851d: Messages and variable descriptions no longer point at internal components: `KINDGI_API_PORT` / `KINDGI_OPENFGA_API_URL` / `KINDGI_SECRETS_BACKEND` descriptions say what the runtime does; the `external` guardrail strategy's error says to register an execution strategy; the payload-version error reads "Unsupported payload version N (this reader handles version M)" — it was worded "newer than this reader" also for older versions.
- aec851d: - `@kindgi/env-schema`: `KINDGI_DATABASE_URL`'s documented dev default is now `postgres://localhost:5432/kindgi`, matching the runtime's new default database name.
  - `@kindgi/sdk`: the `kindgi-getting-started`, `kindgi-authoring-mcp-servers` and `kindgi-framework-feedback` skills no longer list `sources:` paths outside this repository.
