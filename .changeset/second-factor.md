---
"@kindgi/api": patch
---

**A session says how its person gave a second factor.** `SessionCreateInput.secondFactor` and `Session.secondFactor` (optional): `{ method, at }`, where `method` is `totp` (a code from an authenticator app), `recovery-code`, or `identity-provider` (the workspace's own identity provider, which owns the second factor there). A session store keeps it and returns it from `get` and `resolveToken`; `POST /v1/auth/refresh` gives the new session the same one.
