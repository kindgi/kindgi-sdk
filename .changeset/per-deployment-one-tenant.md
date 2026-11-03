---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/env-schema": patch
---

**A runtime serving one tenant can run a pack service per deployment.** With per-deployment routing on, `/v1/system/keys` there also mints keys holding `system:deployments` or `system:pack-env`. Such a key reaches only the routes a pack service orchestrator calls: the deployments list, each deployment's endpoint, its problem and its pack env, and the round routes below. Every other system route stays closed to it, and the system access record keeps each request it makes. A runtime serving one tenant without per-deployment routing is unchanged: its system keys hold `system:license` alone.

**One orchestrator pass at a time.** `POST /v1/system/deployments/round` claims the round for `holdSeconds` (30 to 3600). While another live claim holds it, it answers `409 orchestrator-round-held`. `POST /v1/system/deployments/round/end` ends a claim, and answers `409 orchestrator-round-not-held` once the claim has lapsed and another holds it. A runtime that keeps no rounds answers `501 orchestrator-round-unsupported`. The TypeScript client's `systemDeployments` has `claimRound` and `endRound`, and the Python client's `system_deployments` both too.

**`KINDGI_PACK_ENDPOINT_KMS_KEY`** names the key each deployment's endpoint token is sealed under, a Cloud KMS key or a Key Vault key, so per-deployment routing no longer needs the `postgres` secrets backend. `parsePackEndpointKmsKey` reads it. `KINDGI_PACK_ROUTING` and `KINDGI_PACK_ENDPOINT_HOSTS` now say what per-deployment routing needs at either tenancy.
