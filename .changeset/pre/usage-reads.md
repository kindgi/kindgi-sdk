---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/sdk": patch
"@kindgi/env-schema": patch
---

**Usage reads: a tenant reads its own usage, aggregated, and the operator reads usage across tenants.**

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
