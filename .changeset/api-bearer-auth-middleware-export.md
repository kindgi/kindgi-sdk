---
"@kindgi/api": patch
---

**`bearerAuthMiddleware`, `BearerAuthMiddlewareOptions` and `tokenSignInKey` are exported.** `createApp` mounts the middleware on `/v1/*`. A deployment can now mount it, with the same `resolveToken` and the options it gave `createApp`, on a route of its own that must admit a caller exactly as `/v1` does, such as a page that acts for the signed-in person. That route's checks (an expired, revoked or inactive session, a revoked key's session, the session cookie's origin rule) are then the same code as `/v1`'s. It admits an API key too, and a session that token sign-in opened with one. So a route that admits only a session a person signed in to checks `c.get('sessionId')` after it, and refuses a session for which `tokenSignInKey(c.get('providerId'))` names a key: such a session lasts only while its key does. Nothing changes for `/v1`.
