---
"@kindgi/api": patch
---

**`DELETE /v1/projects/{projectId}` refuses the workspace's default project and a project still in use, and a delete now revokes the keys and sessions limited to the project when the host gives `revokeByProject`.**

- The delete answers `409 project-is-default` for the default project, and `409 project-in-use` for a project that still holds what the workspace keeps (published agents, tools, flows, guardrails or data blocks; deployments; test sets; runs, test runs or triggers; artifacts; company connection choices; audit events; cost records), or that a site is still registered on. Nothing is deleted. Its sites, artifacts and company connection choices can go first; the message names the commands. A project that had a secret or an environment value set on it, a key made limited to it, or a trigger set to run as it, stays too: each of these records an audit event that names the project. `409 project-in-environment-order` is unchanged.
- Once the project is deleted, and again on a repeat delete of a gone project, the keys and the sessions limited to it are revoked. A revoke that fails is logged at error level with the workspace and the project, then tried once more; a second failure is logged too, and the delete still answers 204. Deleting the project again finishes it. The keys name the caller as the one who revoked them; ended sessions are recorded as `sessions-ended`, with the caller as the actor.
- **For a runtime:** `TokenAdmin.revokeByProject` (`TokenRevokeByProjectInput`, `TokenRevokeByProjectOutcome`) and `SessionStoreBinding.revokeByProject` (`SessionRevokeByProjectInput`) are optional. A store without one leaves those keys or sessions until they expire or are revoked one by one, and the delete logs a warning naming them.
- The OpenAPI document gives the delete a `403 permission-denied` and names the three 409 codes, and the errors reference has `project-is-default` and `project-in-use`.
