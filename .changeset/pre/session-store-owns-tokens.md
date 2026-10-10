---
"@kindgi/api": patch
---

A session store can own its session tokens. `SessionStoreBinding` gains an optional `resolveToken({ token })`, and `SessionCreateOutput` an optional `token`. A store that implements them mints the token itself (returned once from `create`; it keeps only a hash), and the auth middleware hands every `kgi_sk_` token to `resolveToken`, which looks only in the tenant the token names. The middleware then never reads sessions across tenants (`MULTI_TENANT_LOOKUP`), and `POST /v1/auth/callback/{providerId}` and `POST /v1/auth/refresh` return the store's token. A store without them keeps the older `kgi_sk_<sessionId>` token, unchanged.
