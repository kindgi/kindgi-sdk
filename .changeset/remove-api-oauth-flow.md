---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Breaking:** the API's own OAuth sign-in flow is removed. Sign-in runs in the deployment (the runtime's browser flow), which reads the identity-provider catalog. The flow in this package was never mounted there, and its in-memory state store broke across instances.
- **Routes removed:** `POST /v1/auth/login/{providerId}` and `POST /v1/auth/callback/{providerId}` now answer 404.
- **`createApp` inputs removed:** `exchangeCode` and `oauthStateStore`.
- **Types removed:**
  - `ExchangeCodeFn`, `ExchangeCodeInput`, `OAuth2ProviderConfig`;
  - `OauthStateStore`, `OauthStateEntry`, `OauthStateTakeInput`, `createInMemoryOauthStateStore`;
  - the OpenAPI schemas `LoginBody`, `AuthorizationResponse`, `CallbackBody`, `CallbackResult` and `OAuth2IdentityProviderConfig`.
- **Clients:** TypeScript `client.auth.login` and `client.auth.callback` are removed, with `LoginInput`, `LoginResult`, `CallbackInput` and `CallbackResultShape`. Python's `auth.login` and `auth.callback` are removed too.
- **The `oauth2` identity-provider kind is removed:** `IdentityProviderKind` is now `oidc | saml`.
  - Registering an `oauth2` provider answers `422 identity-provider-invalid`, as a deployment already refused it.
  - One stored before still lists, with its common fields.
  - `GET /v1/auth/providers/{providerId}/sign-in?kind=oauth2` is now `400 bad-input`.
- **OIDC `allowedRedirectUris` is removed:** only the removed login route enforced it.
  - Sending it is `400 invalid-provider-config`.
  - A provider stored with it still loads, lists and signs people in; the field is left out of what it returns.
- **Unchanged:**
  - the provider catalog;
  - `POST /v1/auth/refresh` (`refreshToken` still rotates a provider refresh token a session holds);
  - `POST /v1/auth/logout`;
  - token sign-in.
