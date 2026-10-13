---
"@kindgi/env-schema": patch
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
---

**A pack service can be pinned to one tenant, and the server's settings for routing each call to its own deployment's pack service are declared** (pack protocol 2.7.0).
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
