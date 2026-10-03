---
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/env-schema": minor
---

A deployment's tools and guardrails keep where their code is, and the trust list it's verified against gets routes.

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
