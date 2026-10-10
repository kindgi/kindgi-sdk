---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Setting up sign-in with an identity provider the way it happens in practice: the identity provider's side first, then Kindgi's.

- **`GET /v1/auth/providers/{providerId}/sign-in?kind=oidc|saml`**: what to give the identity provider (the redirect URI, or SAML's ACS URL, entity ID and metadata URL) **before** anything is registered. The URLs stay the same after registering, after any update, and after an unregister and a new registration under the same id. They aren't secrets: every sign-in's browser redirects carry them. TypeScript `client.auth.providers.signIn(providerId, { kind })`. Backed by the optional `IdentityProviderBinding.signInUrls`.
- **`PATCH /v1/auth/providers/{providerId}`**: change a provider in place (a field given replaces the stored one, `null` removes an optional one). It's checked as a registration is, and keeps its sign-in URLs, so nothing changes on the identity provider's side. `providerId` and `kind` can't change; a new `issuer` drops the endpoints discovered from the old one. TypeScript `client.auth.providers.update(providerId, changes)`. Backed by the optional `IdentityProviderBinding.update`.
- **`GET /v1/auth/providers/{providerId}`**: one provider. TypeScript `client.auth.providers.get(providerId)`.
- **`kindgi sso providers`**: `start` prints the URLs and a message for whoever runs the identity provider (`--idp=google|entra|okta|keycloak` adds its click-by-click steps); `finish` registers what came back; then `update`, `get`, `list`, `test` (the link to try signing in) and `remove`.
