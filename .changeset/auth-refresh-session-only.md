---
"@kindgi/api": patch
---

`POST /v1/auth/refresh` rotates the session token only, and never calls the identity provider. Removed: `createApp`'s `refreshToken` option, plus the `RefreshTokenFn`, `RefreshTokenInput` and `ExchangeCodeOutcome` types it used. No sign-in stores a provider refresh token for it anymore. Also removed from the error table: the codes nothing returns anymore (`oauth-state-invalid`, `oauth-code-exchange-failed`, `oauth-refresh-failed`, `oauth-refresh-not-supported`). Provider tokens a session already holds carry over to the refreshed session, as before.
