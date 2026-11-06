---
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/cli": patch
---

**A tenant admin gives another tenant admin capabilities, and takes them back.** `POST /v1/identity/users/{userId}/capabilities` gives 1 to 32 of them, and `DELETE /v1/identity/users/{userId}/capabilities/{capability}` takes one back. Each answers with the person's grants after. In the TypeScript client, that's `users.giveCapabilities` and `users.takeBackCapability`.

- **What may be given** is only what the admin's own person holds now. What their key was made with never counts, so a service account or a system key gives none (`403 caller-not-a-person`). A capability they don't hold is `403 capability-not-held`, naming the missing ones. No person gives `secrets:reveal` or a system capability (`403 capability-not-givable`). Only a tenant admin is given any (`409 receiver-not-tenant-admin`).
- **Taking back** is for a tenant admin whose own person holds the capability, or for the person themselves, with a full API key or session: not a `member` one, nor one limited to a project. The last holder's may go. One the person doesn't hold is left as it is.
- **The binding:** `PersonCapabilitiesBinding` gains optional `give` and `takeBack`, which check the rest. A runtime without them answers `501 person-capabilities-unsupported`. Both routes also need `personGrants`, as the grants read does.
- **Reading them:** `PersonGrants` gains an optional `capabilities`, on `GET /v1/identity/users/{userId}/grants` and the people list's `include=grants`. An older runtime leaves it out, which means unknown, not none. `kindgi people grants --table` lists them as rows.
- **A person's own:** the routes that let a person read their own record, sessions and grants, or revoke their own sessions, now compare ids as the rest of the API does, whatever their case. A seed user id given in upper case before 0.3.0 now reads its own grants.
