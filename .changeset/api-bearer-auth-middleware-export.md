---
"@kindgi/api": patch
---

**`bearerAuthMiddleware` and `BearerAuthMiddlewareOptions` are exported.** `createApp` mounts the middleware on `/v1/*`. A deployment can now mount it, with the options it gave `createApp`, on a route of its own that must admit a caller exactly as `/v1` does, such as a page that acts for the signed-in person. That route's checks (an expired, revoked or inactive session, a revoked key's session, the session cookie's origin rule) are then the same code as `/v1`'s. It admits an API key too, so a route that admits only a session checks `c.get('sessionId')` after it. Nothing changes for `/v1`.
