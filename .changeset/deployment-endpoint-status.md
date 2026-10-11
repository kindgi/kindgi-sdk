---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A deployment can carry its pack service's status, and the name each deployment's pack service takes is shared.**
- **`endpoint` on a deployment** (`GET /v1/deployments` and `GET /v1/deployments/{id}`), optional: `{ status, since }`, with `status` one of:
  - **`pending`:** no pack service yet; calls to its tools fail (`pack-endpoint-pending`), and never go to another deployment;
  - **`ready`:** calls go to its own pack service;
  - **`cleared`:** its pack service was taken down, and calls fail (`pack-endpoint-cleared`).

  It's present only when the server routes each pack call to the deployment that shipped the tool (`KINDGI_PACK_ROUTING=per-deployment`, from runtime 0.1.8), and absent otherwise. It never carries a URL or a token. The TypeScript and Python clients gain the optional field, and `@kindgi/api` exports `DeploymentEndpoint` and `DeploymentEndpointStatus`.
- **`packServiceName(tenantId, deploymentId)`** (`@kindgi/api`): `kp-` and 20 lowercase base32 characters of `sha256("<tenantId>:<deploymentId>")`, a valid Cloud Run service name. Whatever runs a pack service per deployment names each one this way.
- **`hostNamesPackService(host, name)`:** true when the host begins with the name and then `-` or `.`, so a longer name never passes. The server uses it to check that an endpoint can't point one tenant's deployment at another's service.
