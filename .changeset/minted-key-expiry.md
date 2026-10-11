---
"@kindgi/api": patch
---

**Security: a key can no longer mint a key that outlives it.** Before, `POST /v1/tokens` took the new key's `expiresAt` as given. A short-lived key, even one limited to a project, could therefore mint a key that never expires, and that key kept working after the short-lived one expired or was revoked.
- **A key that expires** mints only keys that expire no later than it does. A later `expiresAt`, or none at all, is refused with 403 `token-expiry-exceeds-minter`; the error's `details.latestExpiresAt` is the latest allowed time.
- **A console session opened by token sign-in** mints as the key it was opened with: the same limit and the same refusal. Once that key is revoked, the session's mint is refused with 401 `auth-revoked`.
- **Unchanged:**
  - the deployment's own token and keys without an expiry, which may still mint keys that never expire;
  - sessions from any other sign-in (an identity provider, a social sign-in, the emailed link).
