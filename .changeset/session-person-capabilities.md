---
"@kindgi/api": patch
---

**A sign-in session can carry the capabilities its person holds.**
- **The new binding:** `personCapabilities` (`PersonCapabilitiesBinding`, optional). Its `held({ tenantId, userId })` returns what a person holds, such as `env:write`, `secrets:write` or `signing-keys:write`.
- **What a session carries:** a sign-in session carries its person's capabilities.
  - They're read on every request, once the session is found valid, so one taken away stops at the next request.
  - A system capability (`kindgi:system`, `system:*`) is never a person's: one the binding returns is dropped.
  - Without the binding, a session carries none, as before.
- **Keys:** an API key carries only the capabilities it was minted with, never its person's.
- **What follows from it:**
  - The writes that need a capability (secrets, env, signing keys) accept such a session.
  - `POST /v1/tokens` lets the person put what they hold on the keys they mint, and nothing more.
  - `GET /v1/identity/me/permissions` lists them in `tokenCapabilities`.
