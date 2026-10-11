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
- **Why a deployment is still `pending`:** an optional `problem: { code, since }` on a pending endpoint, so a deploy that waits for `ready` can say why at once instead of timing out. The code is from a fixed list, never free text:
  - the server refused the endpoint it was given: `endpoint-url-invalid`, `endpoint-host-not-allowed`, `endpoint-name-mismatch`, `endpoint-unreachable`, `endpoint-info-mismatch`, `image-not-allowed`;
  - the pack service couldn't be created: `tenant-not-provisioned`, `capacity-unavailable`, `service-start-failed`.

  A later runtime may add codes, so a client treats an unknown one as a reason not yet named. `@kindgi/api` exports the list as `DEPLOYMENT_ENDPOINT_PROBLEM_CODES`, with the `DeploymentEndpointProblem` and `DeploymentEndpointProblemCode` types.
- **`packServiceName(tenantId, deploymentId)`** (`@kindgi/api`): `kp-` and 20 lowercase base32 characters of `sha256("<tenantId>:<deploymentId>")`, a valid Cloud Run service name. Whatever runs a pack service per deployment names each one this way.
- **`hostNamesPackService(host, name)`:** true when the host begins with the name and then `-` or `.`, so a longer name never passes. The server uses it to check that an endpoint can't point one tenant's deployment at another's service. It checks the first label only: the domain is the hosts allowlist's to check, so a caller runs both.
