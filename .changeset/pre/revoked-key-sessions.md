---
"@kindgi/api": patch
---

**A console session opened with an API token ends when its key is revoked, even when ending it at the revoke failed.** Each request on such a session reads its key. A revoked or missing key is refused with `401 auth-revoked`: "The API key this session was opened with is revoked: sign in again".
- **A key read that fails fails the request** (`500`). It never counts as a live key.
- **Token sign-in needs `createApp`'s `tokenAdmin`**, the deployment's API keys, as well as `session.cookie`, `session.tokenSignIn` and a session store. Without it, `POST /v1/auth/token-sign-in` answers `403 token-sign-in-off` and says why, and `GET /v1/auth/sign-in-options` reports `apiToken: false`. A session naming a key on a server with no keys to read is refused too.
- Identity-provider sessions, the deployment's own token's sessions, and requests with an API key itself read nothing more.
