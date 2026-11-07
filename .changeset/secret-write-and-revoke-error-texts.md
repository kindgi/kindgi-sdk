---
"@kindgi/api": patch
"@kindgi/client": patch
---

The OpenAPI document says what a secret revoke answers when the secret manager fails it: `secrets.revoke` declares `429 secret-provider-rate-limited`, `500 secret-store-error`, `502 secret-provider-unauthorized` and `503 secret-provider-unavailable`, each saying what a soft and a hard revoke left. Its 503 still names `authz-backend-unavailable` and `database-busy`.

The writes that set a secret's value (`secrets.set`, `deployments.syncSecrets` and `tenant.config.upsert`) declare `404 secret-revoked`, for a hard revoke that overtook the write, and their 503 says a hard revoke still erasing the secret answers `secret-provider-unavailable` too. `secrets.rotate`'s 404 names `secret-not-found` and `secret-revoked`, and `secrets.set`'s names `org-not-found` and `project-not-found`. Nothing a request sends or gets back changes.
