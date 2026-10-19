---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/env-schema": patch
---

**A second factor at sign-in, and a workspace setting that requires one, on a runtime that keeps them.** An authenticator app's codes (TOTP), with 10 recovery codes for when the app is lost. Covers the deployment's own ways in (the emailed link, and providers like Google, Microsoft and GitHub); signing in through the workspace's own identity provider is exempt, since it owns the second factor there. API keys aren't covered.

- **The API.** A `secondFactor` binding (`SecondFactorBinding`) mounts:
  - `/v1/identity/me/second-factor`: `GET` yours (`setUp`, `since`, `recoveryCodesLeft`, `usable`, and whether the workspace `required` one); `POST` starts setting one up (the key and its `otpauth://` URI, shown once; replacing one takes a code from it), then `POST …/confirm {code}` sets it up and answers the 10 recovery codes, once; `POST …/recovery-codes` gives 10 new ones; `POST …/remove` takes it off, refused while the workspace requires one. From a session only (`400 auth-not-session-token` with an API key). A key or codes in an answer are never replayed for an `Idempotency-Key`.
  - `GET /v1/identity/users/{userId}/second-factor` and `POST …/second-factor/remove` (tenant admins): a person's, and removing it for a lost phone. Their sessions stay. An admin's own isn't removed there (`403 permission-denied`): it's taken off at `/me`, with a code from it.
  - `GET` / `PATCH /v1/auth/settings` `{ secondFactor: { required } }` (tenant admins), with how many people's keys are still on the previous sign-in secret (`onPreviousSecret`) or on neither (`unusable`). Once required, a session made without a second factor ends at its next request. Turning it on from a session made without one is `409 second-factor-enroll-first`.
  - Token sign-in is refused in a workspace that requires one: `403 second-factor-required`.
  - The sign-in history (`GET /v1/audit/sign-ins`) has three new kinds: `second-factor-set-up`, `second-factor-removed` (with `byUserId` when an admin removed it) and `recovery-codes-replaced`. It never has a key or a code.
  - New error codes: `second-factor-required`, `second-factor-invalid` (403), `second-factor-locked` (429, with `Retry-After`), `second-factor-unusable` (403), `second-factor-enroll-first`, `second-factor-not-set-up`, `second-factor-not-started` (409).
- **A session says how its person gave a second factor.** `SessionCreateInput.secondFactor` and `Session.secondFactor` (optional): `{ method, at }`, where `method` is `totp`, `recovery-code`, `identity-provider`, or `site` (a site signed them in, and owns their second factor). A session store keeps it and returns it from `get` and `resolveToken`; `POST /v1/auth/refresh` gives the new session the same one.
- **The TypeScript client.** `identity.me.secondFactor` (`get`, `start`, `confirm`, `newRecoveryCodes`, `remove`), `users.secondFactor(id)` and `users.removeSecondFactor(id)`, and `auth.settings` (`get`, `update`). A wrong code is an `auth` error whose `serverCode` is `second-factor-invalid`; too many is `rate-limited` (`second-factor-locked`), with `retryAfterSeconds`.
- **The CLI.** `kindgi people second-factor <user-id>`, `kindgi people reset-second-factor <user-id>`, and `kindgi sign-in settings [--require-second-factor=on|off]`. `kindgi exports create` also writes `user-second-factors` (each person's status, never a key) and `sign-in-settings`.
- **Runtime settings** (`@kindgi/env-schema`): `KINDGI_AUTH_PREVIOUS_SECRET_PATH` / `KINDGI_AUTH_PREVIOUS_SECRET`, optional: while the sign-in secret rotates, the one before it, so second-factor keys sealed under it still open.
