---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/compliance": patch
"@kindgi/specs": patch
---

A person's grants: what they may do, read in one call, and tenant admin given or taken. All of it is optional for a runtime: without a `PersonGrantsBinding` the routes answer `501 person-grants-unsupported`.
- **`GET /v1/identity/users/{userId}/grants`:** `{userId, tenantAdmin?, tenantMember?, projects: [{projectId, role}], teams: [{teamId, role}], reviewer?: {role}}`, as granted directly. What a team's or an org's grants imply is not expanded. `tenantMember` says they read the tenant's settings (a person is a member from being added). `tenantAdmin` and `tenantMember` are absent on a runtime without an authorization store. A tenant admin reads anyone's; anyone else only their own (`403 permission-denied`).
- **`POST /v1/identity/users/{userId}/grant` and `/ungrant`** with `{kind: 'tenant-admin'}`, the same shape as a service account's grant. Tenant admins only. The grant is written before the call answers, so the person's next request holds it. Project and team roles keep their membership routes.
- **Refusals:**
  - `404 identity-user-not-found`: no such person.
  - `409 last-tenant-admin`: removing tenant admin from the only person who holds it. Make someone else one first.
  - `409 seed-user-admin`: removing it from the seed user, whom the runtime makes tenant admin at every boot. Unset `KINDGI_SEED_USER_ID` and restart the runtime first.
- **Evidence kinds:** `person-granted` and `person-ungranted` join `EVIDENCE_KINDS` and the evidence schema.
- **TypeScript client:** `users.grants(id)`, `users.grant(id, {kind: 'tenant-admin'})` and `users.ungrant(…)`. The two refusals are classified as conflicts.
- **Python client:** `identity.users.grants`, `.grant` and `.ungrant`, with the `PersonGrants`, `PersonProjectRole`, `PersonTeamRole` and `PersonReviewerRole` models.
- **CLI:** `kindgi people grants <id> [--table]`, and `kindgi people grant|ungrant <id> --tenant-admin`.
