---
"@kindgi/api": patch
"@kindgi/capabilities": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/adapter-model-bedrock": patch
"@kindgi/adapter-model-azure-openai": patch
"@kindgi/env-schema": patch
"@kindgi/sdk": patch
---

**`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and any sign-in as the server.
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
