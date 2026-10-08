---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/env-schema": patch
---

**Upgrading: signing in to the console with an API token is now off by default, except in `kindgi dev`.** If people sign in to your console by pasting an API token, set `KINDGI_CONSOLE_TOKEN_SIGN_IN=on` on the runtime when you upgrade, or set up sign-in with your organization's identity provider. Otherwise the console's sign-in page offers no way in. API tokens keep working for the API, the CLI and the SDKs either way. `kindgi doctor` now warns when nobody can sign in to the console of the runtime it points at.

- **`POST /v1/auth/token-sign-in`**: the API token in `Authorization` is exchanged once for a browser session in the session cookie (HttpOnly, the same as sign-in with an identity provider), so the browser never keeps the token. Only a person's full key opens a session: a service account's key, or a narrowed one (a `member` role, or one project), is refused 403 `token-sign-in-not-allowed`. The session ends after its lifetime, or when the key expires if sooner. 403 `token-sign-in-off` when the deployment doesn't allow it. TypeScript `client.auth.tokenSignIn()`. Enabled by `SessionConfig.tokenSignIn`; audited as `signed-in` (method `api-token`).
- **`GET /v1/auth/sign-in-options`** gains `methods: { identityProviders, apiToken }` (optional: absent from older servers), and is mounted whenever there's a way in, with or without identity providers.
- **`KINDGI_CONSOLE_TOKEN_SIGN_IN`** (`@kindgi/env-schema`): `on` or `off`; default `off`, and `on` in `kindgi dev`.
- **`kindgi doctor`**: a "Console sign-in" check for the runtime the CLI points at (`--url`, `KINDGI_API_URL`, `kindgi auth login`). It warns when token sign-in is off and no identity provider is set up, or none is registered, naming the setting that fixes it.
