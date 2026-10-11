---
"@kindgi/env-schema": patch
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
---

**A pack service can be pinned to one tenant, and the server's settings for routing each call to its own deployment's pack service are declared** (pack protocol 2.7.0).
- **`@kindgi/handler-runtime`:**
  - **`KINDGI_PACK_TENANT_ID`:** it needs a runtime that sends the header (0.1.8 or later). With it set, the pack service refuses, with **421** and `{"code":"pack-tenant-mismatch"}`, a call whose `kindgi-tenant-id` header is missing or names another tenant, and a tool call whose context names another. It refuses before any pack code runs, and the answer names neither tenant. Unset (the default), nothing changes.
  - **Tenant ids compare without regard to case** (they're UUIDs).
  - **It's a backstop for a misrouted call to an honest pack.** The boundary is the server's routing.
  - **`PACK_HEADERS.tenantId`** (`kindgi-tenant-id`): the server sets it on every call, from the deployment it routed the call to.
  - **`GET /v1/info`** reports `indexHash`: `sha256:` and the hex SHA-256 of the service's index file, byte for byte, which is the hash a deployment signs.
- **`@kindgi/env-schema`** (the three routing settings are used from runtime 0.1.8; earlier runtimes ignore them):
  - **`KINDGI_PACK_TENANT_ID`** (the pack service);
  - **`KINDGI_PACK_ROUTING`:** `single` by default, or `per-deployment`;
  - **`KINDGI_PACK_ENDPOINT_HOSTS`:** host names; `*.` and a domain, which matches one more label; or `*-`, a tail and a domain, which matches one more label ending with `-` and the tail. On Cloud Run, the tail form, `*-<project number>.<region>.run.app`, is the one that admits only one project's services;
  - **`KINDGI_PACK_ENDPOINT_NAMES`:** `bound` by default, or `any`.

  Their parsers are exported: `parsePackTenantId`, `parsePackRouting`, `parsePackEndpointHosts`, `packEndpointHostAllowed` and `parsePackEndpointNames`.
- **`@kindgi/specs`:** the pack protocol schema gains the header, the 421, the optional process setting, and `info.indexHash`.
