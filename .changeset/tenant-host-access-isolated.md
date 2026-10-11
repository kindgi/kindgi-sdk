---
"@kindgi/api": patch
"@kindgi/capabilities": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/env-schema": patch
"@kindgi/sdk": patch
---

**`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and the server's own cloud credentials.
- **`@kindgi/api`:**
  - `TENANT_HOST_ACCESS_LEVELS` gains `isolated`, so the `TenantHostAccess` union widens. A caller's exhaustive `switch` over it needs the new case.
  - `HostReach` gains `'private-network'` (RFC 1918, CGNAT 100.64.0.0/10, IPv6 unique-local) and `'ambient-credentials'` (credentials the server's environment holds, used for a registration that names no secret). Only `isolated` denies them.
  - **`stdioRefusal(endpointId, level)`** now takes the level, and names it: "KINDGI_TENANT_HOST_ACCESS=isolated refuses that". Under `isolated`, registering a `stdio` MCP endpoint answers `403 host-access-denied`, as it does under `deployed`.
- **`@kindgi/capabilities`:**
  - `AdapterFactoryInput.ambientCredentials?` and `AdapterConfigCheckInput.ambientCredentials?` (optional) say whether an adapter may fall back to the server's own credentials. Absent means allowed, as before.
  - `createAdapterFactoryRegistry(seed, { ambientCredentials: false })` hands `false` to every factory and every `checkConfig`, and an input can't turn it back on.
- **`@kindgi/adapter-model-gemini`:** with `ambientCredentials: false`, a Vertex AI registration without `secret_ref` is refused by the check and the factory, naming `secret_ref`, instead of signing in with Application Default Credentials. A registration with a service-account key, and the Developer API with its key, are unchanged.
- **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS` takes `isolated`, and its description says what the level refuses. The server won't start with `isolated` together with `KINDGI_DEV`, or with `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow`; that setting's description says so too.
- **`@kindgi/sdk`:** the providers skill says that a runtime with `isolated` needs a Gemini service-account key in `secret_ref`.
