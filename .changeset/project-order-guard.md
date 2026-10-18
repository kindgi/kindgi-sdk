---
"@kindgi/platform": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A project that's a member of an environment order can't be deleted or moved to another parent until it's cleared from the order.** This keeps an order's members from vanishing, or splitting across parents, under the admin who set it.

- `ProjectBinding.delete` now resolves to a `ProjectDeleteOutcome` (`ok`, or `project-in-environment-order` naming the order) rather than `void`; deleting an id that names no project is still `ok` (idempotent). `ProjectUpdateOutcome` gains `project-in-environment-order`, returned only when a patch would change the project's `orgId` — its parent; a rename, slug or description change is never refused on that ground. A host that implements `ProjectBinding` returns the new outcomes; the in-memory reference adapter consults an injected `environmentOrderOf` hook (compose it to the environment-order binding wherever both share a store).
- `DELETE /v1/projects/{projectId}` and `PATCH /v1/projects/{projectId}` answer `409 project-in-environment-order` — with the order's id — in those cases. Every other response is unchanged.
- **An org that's the parent of an environment order can't be deleted until a tenant admin clears the order** — otherwise the order would be left pointing at an org that's gone. `OrgBinding.delete` resolves to `org-has-environment-order` (naming the order) instead of deleting, and `DELETE /v1/orgs/{orgId}` answers `409 org-has-environment-order` with the order's id. The in-memory reference adapter consults an injected `environmentOrderOf` hook, as the project guard does.
