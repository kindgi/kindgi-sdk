---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**Breaking:** `users.create` in the TypeScript client answers with the person it added, not their id. Before: `const id = await client.users.create(spec)`. After: `const { userId } = await client.users.create(spec)`. In the Python client it answers `UserCreated`, which isn't a `UserRecord`: a type annotation or `isinstance` check on its answer changes.

**People added with an email are invited, on a runtime that invites them.** The invitation is open until their first sign-in; past its expiry, every way in refuses them until a tenant admin sends it again.

- **The API.**
  - `POST /v1/identity/users` takes `sendInvite` (default `true`; `false` still invites them, unemailed), and its `201` adds `inviteEmail`: `{ sent, reason? }`, where `reason` is `no-email`, `not-requested`, `not-configured`, `send-failed` or `capped`.
  - A person's record adds `invite` (`{ state: 'pending' | 'expired', expiresAt, sentAt? }`, while it's open) and `firstSignedInAt`.
  - `GET /v1/identity/users?pending=true` lists only the people with an open invitation.
  - `POST /v1/identity/users/{userId}/invite` (tenant admins) sends it again with a new expiry: `200 { user, inviteEmail }`; `409 identity-user-not-invited` for someone who has joined or was never invited; `429 invite-capped`, with `Retry-After`, over the server's limits.
  - Every new response field is optional: a runtime that doesn't invite leaves them out.
- **`IdentityDirectoryBinding`.** `createUser` takes `sendInvite` and may answer `inviteEmail`; an optional `resendInvite` mounts the new route; `listUsers` takes `pending`; `UserRecord` adds `invite` and `firstSignedInAt`. The types are exported (`InviteEmail`, `InviteEmailUnsent`, `UserInvite`, `IdentityResendInviteInput`, `IdentityResendInviteResult`).
- **The TypeScript client.** `users.create` answers `UserCreated` (the `User`, with an optional `inviteEmail`); `UserSpec.sendInvite`; `users.resendInvite(id)` answers `InviteRenewed`; `users.list({ pending: true })`; `User.invite` and `User.firstSignedInAt`. `identity-user-not-invited` is a `conflict`, and `invite-capped` is `rate-limited`, with `retryAfterSeconds`.
- **The Python client** has the same: `users.create` takes `send_invite` and answers `UserCreated` (a `UserRecord`'s fields, and `invite_email`) where it answered `UserRecord`; `users.resend_invite(user_id)`; `users.list(pending=True)`.
- **The CLI.** `kindgi people add` says whether the invitation was emailed, and why not, and takes `--no-invite`; `kindgi people invite <user-id>` sends it again; `kindgi people list --pending` lists the invited, and the table has a STATE column.
