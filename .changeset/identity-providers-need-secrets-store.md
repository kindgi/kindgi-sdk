---
"@kindgi/api": patch
"@kindgi/env-schema": patch
---

A deployment without a secrets store (`KINDGI_SECRETS_BACKEND=none`) can say it takes no identity provider of a tenant's own: a provider's client secret and keys are references into a store. The binding's `register` and `update` may answer `{ kind: 'needs-secrets-store' }`, and `POST /v1/auth/providers` and `PATCH /v1/auth/providers/{providerId}` then answer `409 identity-providers-need-secrets-store`: "This deployment has no secrets store (KINDGI_SECRETS_BACKEND), and an identity provider's client secret and keys are references into one: identity providers can't be added or changed here until it has one." Removing a provider still works. The clients read the new code as a conflict, by its status. `KINDGI_SECRETS_BACKEND`'s description in the environment schema says so.
