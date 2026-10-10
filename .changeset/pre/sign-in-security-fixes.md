---
"@kindgi/api": patch
---

Sign-in security fixes:
- **CSRF:** a deployment without `KINDGI_PUBLIC_URL` (the same-origin check) now accepts a cookie-authenticated change only from an `https:` Origin, or plain `http:` on loopback. A plain-http page on the same host, an on-path attacker's, is refused `403 csrf-origin-mismatch`.
- **Session stores:** `createApp` refuses cookie sessions over a session store without `resolveToken`. The cookie would otherwise hold the session id, which isn't secret (whoami and the audit trail show it).
- **Audit trail:**
  - token sign-in audits its refusals (`sign-in-refused`, with the reason);
  - logging out audits `signed-out`, with the session id (`logoutHandler` takes an optional audit binding);
  - `revoke-sessions` passes who asked to the directory (`IdentityRevokeSessionsInput.revokedBy`).
- **New optional store method:** `SessionStoreBinding.revokeByProvider` ends every live session one provider opened. Deployments use it when an API key is revoked: token sign-in's sessions are `api-token:<tokenId>`, so a session no longer outlives its key. They also use it when an identity provider is removed.
- **500 bodies:** a 500 caused by a failed database query says only "A database query failed."; the query's SQL and values stay in the log.
