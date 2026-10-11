---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

A project role to give is `owner`, `admin`, `editor` or `viewer`. `member`, an undocumented older name for `viewer`, is refused: adding or changing a project membership, or giving a service account a project role, with `member` is a `400 bad-input` that says to use `viewer`. A role given as `member` before still reads back as `member`, granting what `viewer` does. In the TypeScript client, writes take `AssignableProjectRoleValue` (memberships) and `ServiceAccountGrantInput` (service accounts); the Python client's request models take the four roles. `kindgi service-accounts` lists the four.
