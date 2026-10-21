# @kindgi/platform

## 0.1.10-rc.1

### Patch Changes

- @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- 25a7309: **A tenant can be renamed: its name, its slug, or both.** Its id stays, so whatever names it by its id keeps working.
  - **`PATCH /v1/tenant`** renames your own tenant. It's for tenant admins. **`PATCH /v1/system/tenants/{tenantId}`** renames any tenant, for an operator's key with `system:tenants`, whose scope now reads "Create, list, read, rename and close tenants." Both take a `TenantPatch` body (`name`, `slug`, each optional; a field left out stays as it is) and an optional `Idempotency-Key`, and answer `204` with no body. The same values again also answer `204` and change nothing.
  - **A slug follows the rule creating a tenant has:** lowercase letters, digits and single hyphens, at most 63 characters, unique across tenants. A name is non-empty, at most 100 characters.
  - **Refusals:** `409 tenant-slug-taken` (another tenant has the slug; a purged tenant keeps its own), `409 tenant-closing`, and two new codes. `409 tenant-slug-in-config`: the server's `KINDGI_AUTH_VERIFIED_DOMAINS` names this tenant by its slug, or names the slug asked for. The server's operator names the tenant there by its id and restarts; then rename it. `409 tenant-setup-pending`: the tenant's creation hasn't finished; sending the request that created it again finishes it.
  - **The clients:** `tenant.update(input)` and `systemTenants.update(tenantId, input)` in TypeScript, both `Promise<void>` (`RenameTenantInput` is the body); `tenant.update` and `system_tenants.update` in Python, sync and async, returning `None`. Read the tenant back with `get()`.
  - **For a runtime:** `TenantHierarchyBinding.renameTenant` is optional, and the two routes mount only when it's there. A runtime without it answers `404` on both, as before.
- @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- d563887: **A project that's a member of an environment order can't be deleted or moved to another parent until it's cleared from the order.** This keeps an order's members from vanishing, or splitting across parents, under the admin who set it.
  
  - `ProjectBinding.delete` now resolves to a `ProjectDeleteOutcome` (`ok`, or `project-in-environment-order` naming the order) rather than `void`; deleting an id that names no project is still `ok` (idempotent). `ProjectUpdateOutcome` gains `project-in-environment-order`, returned only when a patch would change the project's `orgId` — its parent; a rename, slug or description change is never refused on that ground. A host that implements `ProjectBinding` returns the new outcomes; the in-memory reference adapter consults an injected `environmentOrderOf` hook (compose it to the environment-order binding wherever both share a store).
  - `DELETE /v1/projects/{projectId}` and `PATCH /v1/projects/{projectId}` answer `409 project-in-environment-order` — with the order's id — in those cases. Every other response is unchanged.
  - **An org that's the parent of an environment order can't be deleted until a tenant admin clears the order** — otherwise the order would be left pointing at an org that's gone. `OrgBinding.delete` now resolves to an `OrgDeleteOutcome` (`ok`, `org-has-environment-order` naming the order, or the existing `slug-conflict`) rather than `void`, and `DELETE /v1/orgs/{orgId}` answers `409 org-has-environment-order` with the order's id. The in-memory reference adapter consults an injected `environmentOrderOf` hook, as the project guard does.
  
  **Breaking for custom platform bindings.** Both `ProjectBinding.delete` and `OrgBinding.delete` now resolve to an explicit outcome — `ProjectDeleteOutcome` and `OrgDeleteOutcome` — and never `void`: a success is `{ kind: 'ok' }`. The former `OrgDeleteConflict` type is gone, folded into `OrgDeleteOutcome` (`ok` | `slug-conflict` | `org-has-environment-order`); `ProjectDeleteOutcome` is `ok` | `project-in-environment-order`. A host that implements either binding must return `{ kind: 'ok' }` where it used to return nothing — so a binding that never checks environment orders can no longer silently delete a project or org that an order names. The conformance suites (`runProjectBindingConformance`, `runOrgBindingConformance`) assert the `ok` outcome on a plain delete, and both reference adapters are updated.
- 409b9bf: A person a site signs in holds only the grants their site's sign-in writes. A deployment's bindings refuse any other grant naming such a person with `site-person-grants-managed`, and the API answers it as `403` on these routes:
  - adding a project or team member, or changing their role (`AddProjectMemberError`, `AddTeamMemberError` and `MembershipWriteError` gain the code);
  - granting tenant admin (`PersonGrantErrorCode`);
  - registering a reviewer (`ReviewerRegisterOutcome` gains a `refused` outcome);
  - removing such a person's project or team membership, or unregistering them as a reviewer (`ReviewerUnregisterOutcome` gains an optional `refused`). Their site would give it back at their next sign-in, so the answer points at the real levers: remove the person, change their role on the site, or pause the site.
  - minting an API key for such a person (`TokenMintRefusal` gains the code). Their access is only the sessions their site's sign-in gives, which end when the site is paused or unregistered; a key would outlive both.
  
  `@kindgi/env-schema` gains `KINDGI_SITE_SIGN_IN`: `true` lets sites sign their people in. The runtime needs authorization enforced and `KINDGI_PUBLIC_URL` for it; it's off by default.
- @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- d563887: **A project that's a member of an environment order can't be deleted or moved to another parent until it's cleared from the order.** This keeps an order's members from vanishing, or splitting across parents, under the admin who set it.
  
  - `ProjectBinding.delete` now resolves to a `ProjectDeleteOutcome` (`ok`, or `project-in-environment-order` naming the order) rather than `void`; deleting an id that names no project is still `ok` (idempotent). `ProjectUpdateOutcome` gains `project-in-environment-order`, returned only when a patch would change the project's `orgId` — its parent; a rename, slug or description change is never refused on that ground. A host that implements `ProjectBinding` returns the new outcomes; the in-memory reference adapter consults an injected `environmentOrderOf` hook (compose it to the environment-order binding wherever both share a store).
  - `DELETE /v1/projects/{projectId}` and `PATCH /v1/projects/{projectId}` answer `409 project-in-environment-order` — with the order's id — in those cases. Every other response is unchanged.
  - **An org that's the parent of an environment order can't be deleted until a tenant admin clears the order** — otherwise the order would be left pointing at an org that's gone. `OrgBinding.delete` now resolves to an `OrgDeleteOutcome` (`ok`, `org-has-environment-order` naming the order, or the existing `slug-conflict`) rather than `void`, and `DELETE /v1/orgs/{orgId}` answers `409 org-has-environment-order` with the order's id. The in-memory reference adapter consults an injected `environmentOrderOf` hook, as the project guard does.
  
  **Breaking for custom platform bindings.** Both `ProjectBinding.delete` and `OrgBinding.delete` now resolve to an explicit outcome — `ProjectDeleteOutcome` and `OrgDeleteOutcome` — and never `void`: a success is `{ kind: 'ok' }`. The former `OrgDeleteConflict` type is gone, folded into `OrgDeleteOutcome` (`ok` | `slug-conflict` | `org-has-environment-order`); `ProjectDeleteOutcome` is `ok` | `project-in-environment-order`. A host that implements either binding must return `{ kind: 'ok' }` where it used to return nothing — so a binding that never checks environment orders can no longer silently delete a project or org that an order names. The conformance suites (`runProjectBindingConformance`, `runOrgBindingConformance`) assert the `ok` outcome on a plain delete, and both reference adapters are updated.
- 409b9bf: A person a site signs in holds only the grants their site's sign-in writes. A deployment's bindings refuse any other grant naming such a person with `site-person-grants-managed`, and the API answers it as `403` on these routes:
  - adding a project or team member, or changing their role (`AddProjectMemberError`, `AddTeamMemberError` and `MembershipWriteError` gain the code);
  - granting tenant admin (`PersonGrantErrorCode`);
  - registering a reviewer (`ReviewerRegisterOutcome` gains a `refused` outcome);
  - removing such a person's project or team membership, or unregistering them as a reviewer (`ReviewerUnregisterOutcome` gains an optional `refused`). Their site would give it back at their next sign-in, so the answer points at the real levers: remove the person, change their role on the site, or pause the site.
  - minting an API key for such a person (`TokenMintRefusal` gains the code). Their access is only the sessions their site's sign-in gives, which end when the site is paused or unregistered; a key would outlive both.
  
  `@kindgi/env-schema` gains `KINDGI_SITE_SIGN_IN`: `true` lets sites sign their people in. The runtime needs authorization enforced and `KINDGI_PUBLIC_URL` for it; it's off by default.
- @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- ebf405d: **A project can be put in production, and the runtime can gate it.** A run in a project in production is a production run; a run anywhere else is staging.
  - **`PUT /v1/projects/{projectId}/production`**, body `{ "production": true | false }`, for tenant admins, both ways. It answers `{ projectId, productionSince }`, where `productionSince` is `null` once the project is out of production. Setting what's already set changes nothing and keeps the first `productionSince`. The TypeScript client has `projects.setProduction(projectId, production)`, and the Python client `projects.production.set(project_id, production=…)`.
  - **The production gate:** with `KINDGI_PRODUCTION_GATE=on`, putting a project in production is refused with `403 production-not-allowed` while the tenant isn't allowed it. The error's `details` carry the `projectId` and, from `KINDGI_PRODUCTION_NEXT_URL`, a `next` URL saying where to go. A project already in production stays so. Off by default, so nothing changes for a self-hosted runtime.
  - **Reads:** a project read shows `productionSince` while the project is in production. `GET /v1/tenant` gains optional `productionAllowed`, `productionNext` (only while it's `false`) and `limits`, when the runtime knows them.
  - **For runtimes:** `Project.productionSince?`, an optional `ProjectBinding.setProduction?` (without it, the route answers `501 production-unsupported`), and `TenantSummary`'s optional `productionAllowed` and `limits` (`TenantLimits`). `createApp` takes `production: { gate?, next? }`.
  - **The usage vocabulary:** `USAGE_CLASSES` (`production`, `staging`, `dry-run`, `replay`, `eval`, `child`) and `USAGE_KINDS`, for a runtime that counts usage (`KINDGI_USAGE_METERING`).
  - **New settings, documented:** `KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`.
- ebf405d: **A tenant can have a limit on its projects in production.** The new limit `projectsInProduction` sits in `TenantLimits`, beside the others, and is set through `PUT /v1/system/tenants/{tenantId}/limits`. It works like them: unset, it isn't enforced, and a self-hosted runtime sets none unless its operator does.
  - **The refusal:** with the limit set, `PUT /v1/projects/{projectId}/production` refuses another project with `403 production-limit-reached` while the tenant has that many in production, or more. `details` carries `limit: 'projects-in-production'`, the limit (`projectsInProduction`), the count (`inProduction`), the `projectId`, and `next` when the runtime names where to go (`KINDGI_PRODUCTION_NEXT_URL`).
  - **What's never counted or refused:** a project already in production answers its repeat 200, uncounted. Taking a project out is never refused.
  - **Lowering the limit** takes no project out of production. The next one waits until the count is under the limit.
  - **Order:** with the production gate on, a tenant that isn't allowed is refused `production-not-allowed` first.
  - **The binding:** `ProjectBinding.setProduction` reads the tenant's limit itself, where the runtime keeps it, and answers `limit-reached` (with the limit and the count) without a change. It reads the limit, counts the tenant's projects in production and changes the project in one step, so two projects put in production at once can't both take the last place, and a limit changed meanwhile is the one counted against. The in-memory binding takes its reader at construction (`productionLimit`). The conformance suite's `productionLimit` option checks a binding against it, setting the limit through the `setProductionLimit` its `makeBinding` returns.
  - **The count, read:** `GET /v1/system/tenants/{tenantId}/limits` answers an optional `inUse: { projectsInProduction }` from a runtime whose `SystemTenantSettingsBinding` has the new optional `inUse(tenantId)`. The count can be over a limit that was lowered below it.
  - **`KINDGI_PRODUCTION_NEXT_URL`** is the `details.next` of both refusals, `production-not-allowed` and `production-limit-reached`, and its description says so. `KINDGI_PRODUCTION_GATE`'s no longer assumes a payment card.
- Updated dependencies [ebf405d]
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

- ebf405d: **A project can be put in production, and the runtime can gate it.** A run in a project in production is a production run; a run anywhere else is staging.
  - **`PUT /v1/projects/{projectId}/production`**, body `{ "production": true | false }`, for tenant admins, both ways. It answers `{ projectId, productionSince }`, where `productionSince` is `null` once the project is out of production. Setting what's already set changes nothing and keeps the first `productionSince`. The TypeScript client has `projects.setProduction(projectId, production)`, and the Python client `projects.production.set(project_id, production=…)`.
  - **The production gate:** with `KINDGI_PRODUCTION_GATE=on`, putting a project in production is refused with `403 production-not-allowed` while the tenant isn't allowed it. The error's `details` carry the `projectId` and, from `KINDGI_PRODUCTION_NEXT_URL`, a `next` URL saying where to go. A project already in production stays so. Off by default, so nothing changes for a self-hosted runtime.
  - **Reads:** a project read shows `productionSince` while the project is in production. `GET /v1/tenant` gains optional `productionAllowed`, `productionNext` (only while it's `false`) and `limits`, when the runtime knows them.
  - **For runtimes:** `Project.productionSince?`, an optional `ProjectBinding.setProduction?` (without it, the route answers `501 production-unsupported`), and `TenantSummary`'s optional `productionAllowed` and `limits` (`TenantLimits`). `createApp` takes `production: { gate?, next? }`.
  - **The usage vocabulary:** `USAGE_CLASSES` (`production`, `staging`, `dry-run`, `replay`, `eval`, `child`) and `USAGE_KINDS`, for a runtime that counts usage (`KINDGI_USAGE_METERING`).
  - **New settings, documented:** `KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`.
- ebf405d: **A tenant can have a limit on its projects in production.** The new limit `projectsInProduction` sits in `TenantLimits`, beside the others, and is set through `PUT /v1/system/tenants/{tenantId}/limits`. It works like them: unset, it isn't enforced, and a self-hosted runtime sets none unless its operator does.
  - **The refusal:** with the limit set, `PUT /v1/projects/{projectId}/production` refuses another project with `403 production-limit-reached` while the tenant has that many in production, or more. `details` carries `limit: 'projects-in-production'`, the limit (`projectsInProduction`), the count (`inProduction`), the `projectId`, and `next` when the runtime names where to go (`KINDGI_PRODUCTION_NEXT_URL`).
  - **What's never counted or refused:** a project already in production answers its repeat 200, uncounted. Taking a project out is never refused.
  - **Lowering the limit** takes no project out of production. The next one waits until the count is under the limit.
  - **Order:** with the production gate on, a tenant that isn't allowed is refused `production-not-allowed` first.
  - **The binding:** `ProjectBinding.setProduction` reads the tenant's limit itself, where the runtime keeps it, and answers `limit-reached` (with the limit and the count) without a change. It reads the limit, counts the tenant's projects in production and changes the project in one step, so two projects put in production at once can't both take the last place, and a limit changed meanwhile is the one counted against. The in-memory binding takes its reader at construction (`productionLimit`). The conformance suite's `productionLimit` option checks a binding against it, setting the limit through the `setProductionLimit` its `makeBinding` returns.
  - **The count, read:** `GET /v1/system/tenants/{tenantId}/limits` answers an optional `inUse: { projectsInProduction }` from a runtime whose `SystemTenantSettingsBinding` has the new optional `inUse(tenantId)`. The count can be over a limit that was lowered below it.
  - **`KINDGI_PRODUCTION_NEXT_URL`** is the `details.next` of both refusals, `production-not-allowed` and `production-limit-reached`, and its description says so. `KINDGI_PRODUCTION_GATE`'s no longer assumes a payment card.
- Updated dependencies [ebf405d]
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- b90e2c6: Adding a team member names a person of the tenant, as adding a project member does.
  - **`POST /v1/teams/{teamId}/memberships`:** someone who isn't a person of this tenant, was removed from it, or is named by an id that isn't one, is refused with 404 `identity-user-not-found`, and nothing is added. Before, a well-formed id the tenant doesn't have was added as a member, and a malformed one could fail with a 500 on a runtime's database.
  - **`teamsRouter`** takes the identity directory (`createApp` passes `identityDirectory`, as it does to `projectsRouter`). Without a directory, an id is taken as given.
  - **`TeamProjectGrant.grantedAt`** says it's also absent for a grant from before 0.1.6.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7

## 0.1.7-rc.0

### Patch Changes

- b90e2c6: Adding a team member names a person of the tenant, as adding a project member does.
  - **`POST /v1/teams/{teamId}/memberships`:** someone who isn't a person of this tenant, was removed from it, or is named by an id that isn't one, is refused with 404 `identity-user-not-found`, and nothing is added. Before, a well-formed id the tenant doesn't have was added as a member, and a malformed one could fail with a 500 on a runtime's database.
  - **`teamsRouter`** takes the identity directory (`createApp` passes `identityDirectory`, as it does to `projectsRouter`). Without a directory, an id is taken as given.
  - **`TeamProjectGrant.grantedAt`** says it's also absent for a grant from before 0.1.6.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0

## 0.1.6

### Patch Changes

- 307771f: A team can have a role on a project. `POST /v1/projects/{projectId}/team-grants` gives one (`viewer`, `editor` or `admin`; a team never owns a project), and every member of the team then holds it there. Giving it takes `admin` on the project and `read` on the team. Adding a role the team already holds answers `201` with the existing grant; another is `409 team-grant-exists` (`details.role`). `PATCH` and `DELETE …/team-grants/{teamId}` change and remove it. `GET …/team-grants` lists a project's, and `GET /v1/teams/{teamId}/project-grants` a team's; each grant names its team and project. In TypeScript, `projects.teamGrants` and `teams.projectGrants`; in Python, `projects.team_grants` and `teams.project_grants`.
  
  Who sees who has access: listing a project's members or team grants takes `write` on the project (its editors and admins), so a viewer no longer sees who else works there. Listing a team's members or its projects takes `admin` on the team. Everyone reads their own roles through their grants.
  
  Re-adding a project or team member with another role is `409 membership-exists`, naming the role they hold (`details.role`), which is kept. The same role answers `201` as before. With authorization on, deleting a team takes its tuples with it (its members' roles and its project grants).
  
  `@kindgi/platform`:
  - `TeamProjectRole` is new.
  - The membership add outcomes and the hierarchy's add errors gain `membership-exists`.
  - `TeamProjectGrant` gains `grantedAt`, and its binding an optional `get`.
  - `TenantHierarchyBinding` gains optional `addTeamProjectGrant`, `updateTeamProjectGrantRole`, `removeTeamProjectGrant` and `deleteTeam`.
- Updated dependencies [b4bbd95]
  - @kindgi/types@0.1.6

## 0.1.6-rc.0

### Patch Changes

- 307771f: A team can have a role on a project. `POST /v1/projects/{projectId}/team-grants` gives one (`viewer`, `editor` or `admin`; a team never owns a project), and every member of the team then holds it there. Giving it takes `admin` on the project and `read` on the team. Adding a role the team already holds answers `201` with the existing grant; another is `409 team-grant-exists` (`details.role`). `PATCH` and `DELETE …/team-grants/{teamId}` change and remove it. `GET …/team-grants` lists a project's, and `GET /v1/teams/{teamId}/project-grants` a team's; each grant names its team and project. In TypeScript, `projects.teamGrants` and `teams.projectGrants`; in Python, `projects.team_grants` and `teams.project_grants`.
  
  Who sees who has access: listing a project's members or team grants takes `write` on the project (its editors and admins), so a viewer no longer sees who else works there. Listing a team's members or its projects takes `admin` on the team. Everyone reads their own roles through their grants.
  
  Re-adding a project or team member with another role is `409 membership-exists`, naming the role they hold (`details.role`), which is kept. The same role answers `201` as before. With authorization on, deleting a team takes its tuples with it (its members' roles and its project grants).
  
  `@kindgi/platform`:
  - `TeamProjectRole` is new.
  - The membership add outcomes and the hierarchy's add errors gain `membership-exists`.
  - `TeamProjectGrant` gains `grantedAt`, and its binding an optional `get`.
  - `TenantHierarchyBinding` gains optional `addTeamProjectGrant`, `updateTeamProjectGrantRole`, `removeTeamProjectGrant` and `deleteTeam`.
- Updated dependencies [b4bbd95]
  - @kindgi/types@0.1.6-rc.0

## 0.1.5

### Patch Changes

- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5

## 0.1.5-rc.0

### Patch Changes

- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 7a8e764: A duplicate org, team or project slug is a `409 slug-conflict`, not a `500`. `POST /v1/orgs`, `/v1/teams` and `/v1/projects` with a slug the tenant already has, and a `PATCH` to one, answered `500`; now `409 slug-conflict` (`Another project in the tenant has the slug "acme"`, with `details: { resource, slug }`), whether or not the deployment enforces authorization. A second Default project is `409 project-default-already-exists`. A `PATCH` of a missing org, team or project, a member added to a team or project deleted mid-request, and a role change for a non-member answer their `404`s from the binding's outcome instead of matching an error message. The TypeScript and Python clients read both new codes as a conflict (`ConflictError` in Python).
  
  **Breaking for custom platform bindings.** `OrgBinding`, `TeamBinding`, `ProjectBinding`, `TeamMembershipBinding` and `ProjectMembershipBinding` writes no longer reject for a caller mistake; they resolve to an outcome discriminated on `kind`: `create` to `{ kind: 'ok', orgId | teamId | projectId }`, `slug-conflict` or (projects) `project-default-already-exists`; `update` to `ok`, `*-not-found` or `slug-conflict`; a membership's `add` and `updateRole` to `ok`, `team-not-found` / `project-not-found` or `*-membership-not-found`. The types are exported (`OrgCreateOutcome`, `ProjectUpdateOutcome`, …). The in-memory bindings keep slugs unique within a tenant. `TenantHierarchyBinding.addTeamMember` / `addProjectMember` fail with `AddTeamMemberError` / `AddProjectMemberError` (`team-not-found` / `project-not-found`, or `add-failed`), which replace `MembershipMutationError`. A binding of your own needs the same changes; the conformance suites in `@kindgi/platform`'s `tests/` check them.
- 71412f6: With authorization enforced, every membership change keeps the authorization store in step. `TenantHierarchyBinding` gains optional `removeTeamMember`, `updateTeamMemberRole`, `removeProjectMember` and `updateProjectMemberRole`, which change the membership row and its authorization tuple together. With an authorizer wired, `DELETE` and `PATCH /v1/{teams,projects}/{id}/memberships/{userId}` go through them. A binding without them is refused with `501 authz-membership-unsupported`, and nothing is changed. Without an authorizer, the membership bindings are used, as before.
  
  With authorization enforced, registering or unregistering an approval reviewer (`POST /v1/approvals/reviewers`, `POST /v1/approvals/reviewers/{id}/unregister`) needs `admin` on the tenant. Reading the roster doesn't.
- 06b5fc0: Creating a project or team with an `orgId` that names no org of the tenant (one that never existed, or a deleted one), or moving one there, answers `404 org-not-found` (`No org with id "<id>"`), as `GET /v1/orgs/{id}` does, instead of a 500. `ProjectCreateOutcome`, `ProjectUpdateOutcome`, `TeamCreateOutcome` and `TeamUpdateOutcome` gain `org-not-found`, and so do `CreateProjectError` and `CreateTeamError` (the authorized path). The in-memory bindings check orgs when given `orgExists`.
- e17b230: Deleting an org is a tombstone, and `org` is a retention domain. `OrgBinding.delete` no longer erases the org: from then on `get`, `list` and `update` treat it as unknown, and its slug is free for a new org, as before; a retention policy on `org` (new in `RETENTION_DOMAINS`) purges the row. The in-memory binding tombstones too, and the conformance suite checks that a deleted org is unknown to every read, frees its slug, and can be deleted again. `DELETE /v1/orgs/{orgId}` describes what the Kindgi runtime does: the org's projects and teams stay, without an org; the org's own secrets and secret mappings are deleted with it, for good; its own environments and MCP endpoints are unregistered.
- e7e2f86: A write whose body names a project it can't use is refused before anything is written: a `projectId` that isn't a project id (a UUID) is `400 bad-input` ("`projectId` must be a project id (a UUID)"), and one that names no project of the tenant is `404 project-not-found` (`details.projectId`). This covers `POST /v1/runs`, `/v1/tokens`, `/v1/agents`, `/v1/agents/{agentId}/versions`, `/v1/flows`, `/v1/tools`, `/v1/guardrails`, `/v1/eval-suites`, `…/versions/from-judgments`, `/v1/eval-suites/{suiteId}/runs` and `/v1/blocks`. Before, an unknown project failed the runtime's insert as a `500` whose message named a table and a foreign key. `POST /v1/conversations` keeps its documented `400 bad-input` for an unknown project. `@kindgi/platform`'s in-memory project binding makes UUID ids, as the wire's `Project.id` is.
- 3d23304: A project's slug is unique within its org, not the whole tenant: two orgs may each have a project called `intake`. A project without an org has a slug unique among the tenant's projects without one. An org's and a team's slug stay unique in the tenant.
  
  - **`409 slug-conflict`** on `POST /v1/projects` when the org already has the slug. `PATCH /v1/projects/:id` answers it for a new slug, and now also for a move to another org (`orgId`, or `null` for none) where the slug is taken. The message says where: "Another project in its org has the slug …".
  - **Deleting an org** leaves its projects without an org. When one of them has the slug of a project that has none, `DELETE /v1/orgs/:id` deletes nothing and answers `409 slug-conflict` naming the slugs (`details.slugs`); rename or move those projects first. `OrgBinding.delete` may return `{ kind: 'slug-conflict', slugs }` (`OrgDeleteConflict`). A binding that returns nothing deletes as before.
  - The in-memory `ProjectBinding` checks slugs per org, and the binding conformance suite pins the per-org cases.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- 71412f6: With authorization enforced, every membership change keeps the authorization store in step. `TenantHierarchyBinding` gains optional `removeTeamMember`, `updateTeamMemberRole`, `removeProjectMember` and `updateProjectMemberRole`, which change the membership row and its authorization tuple together. With an authorizer wired, `DELETE` and `PATCH /v1/{teams,projects}/{id}/memberships/{userId}` go through them. A binding without them is refused with `501 authz-membership-unsupported`, and nothing is changed. Without an authorizer, the membership bindings are used, as before.
  
  With authorization enforced, registering or unregistering an approval reviewer (`POST /v1/approvals/reviewers`, `POST /v1/approvals/reviewers/{id}/unregister`) needs `admin` on the tenant. Reading the roster doesn't.
- e7e2f86: A write whose body names a project it can't use is refused before anything is written: a `projectId` that isn't a project id (a UUID) is `400 bad-input` ("`projectId` must be a project id (a UUID)"), and one that names no project of the tenant is `404 project-not-found` (`details.projectId`). This covers `POST /v1/runs`, `/v1/tokens`, `/v1/agents`, `/v1/agents/{agentId}/versions`, `/v1/flows`, `/v1/tools`, `/v1/guardrails`, `/v1/eval-suites`, `…/versions/from-judgments`, `/v1/eval-suites/{suiteId}/runs` and `/v1/blocks`. Before, an unknown project failed the runtime's insert as a `500` whose message named a table and a foreign key. `POST /v1/conversations` keeps its documented `400 bad-input` for an unknown project. `@kindgi/platform`'s in-memory project binding makes UUID ids, as the wire's `Project.id` is.
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- 06b5fc0: Creating a project or team with an `orgId` that names no org of the tenant (one that never existed, or a deleted one), or moving one there, answers `404 org-not-found` (`No org with id "<id>"`), as `GET /v1/orgs/{id}` does, instead of a 500. `ProjectCreateOutcome`, `ProjectUpdateOutcome`, `TeamCreateOutcome` and `TeamUpdateOutcome` gain `org-not-found`, and so do `CreateProjectError` and `CreateTeamError` (the authorized path). The in-memory bindings check orgs when given `orgExists`.
- @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- 7a8e764: A duplicate org, team or project slug is a `409 slug-conflict`, not a `500`. `POST /v1/orgs`, `/v1/teams` and `/v1/projects` with a slug the tenant already has, and a `PATCH` to one, answered `500`; now `409 slug-conflict` (`Another project in the tenant has the slug "acme"`, with `details: { resource, slug }`), whether or not the deployment enforces authorization. A second Default project is `409 project-default-already-exists`. A `PATCH` of a missing org, team or project, a member added to a team or project deleted mid-request, and a role change for a non-member answer their `404`s from the binding's outcome instead of matching an error message. The TypeScript and Python clients read both new codes as a conflict (`ConflictError` in Python).
  
  **Breaking for custom platform bindings.** `OrgBinding`, `TeamBinding`, `ProjectBinding`, `TeamMembershipBinding` and `ProjectMembershipBinding` writes no longer reject for a caller mistake; they resolve to an outcome discriminated on `kind`: `create` to `{ kind: 'ok', orgId | teamId | projectId }`, `slug-conflict` or (projects) `project-default-already-exists`; `update` to `ok`, `*-not-found` or `slug-conflict`; a membership's `add` and `updateRole` to `ok`, `team-not-found` / `project-not-found` or `*-membership-not-found`. The types are exported (`OrgCreateOutcome`, `ProjectUpdateOutcome`, …). The in-memory bindings keep slugs unique within a tenant. `TenantHierarchyBinding.addTeamMember` / `addProjectMember` fail with `AddTeamMemberError` / `AddProjectMemberError` (`team-not-found` / `project-not-found`, or `add-failed`), which replace `MembershipMutationError`. A binding of your own needs the same changes; the conformance suites in `@kindgi/platform`'s `tests/` check them.
- e17b230: Deleting an org is a tombstone, and `org` is a retention domain. `OrgBinding.delete` no longer erases the org: from then on `get`, `list` and `update` treat it as unknown, and its slug is free for a new org, as before; a retention policy on `org` (new in `RETENTION_DOMAINS`) purges the row. The in-memory binding tombstones too, and the conformance suite checks that a deleted org is unknown to every read, frees its slug, and can be deleted again. `DELETE /v1/orgs/{orgId}` describes what the Kindgi runtime does: the org's projects and teams stay, without an org; the org's own secrets and secret mappings are deleted with it, for good; its own environments and MCP endpoints are unregistered.
- 3d23304: A project's slug is unique within its org, not the whole tenant: two orgs may each have a project called `intake`. A project without an org has a slug unique among the tenant's projects without one. An org's and a team's slug stay unique in the tenant.
  
  - **`409 slug-conflict`** on `POST /v1/projects` when the org already has the slug. `PATCH /v1/projects/:id` answers it for a new slug, and now also for a move to another org (`orgId`, or `null` for none) where the slug is taken. The message says where: "Another project in its org has the slug …".
  - **Deleting an org** leaves its projects without an org. When one of them has the slug of a project that has none, `DELETE /v1/orgs/:id` deletes nothing and answers `409 slug-conflict` naming the slugs (`details.slugs`); rename or move those projects first. `OrgBinding.delete` may return `{ kind: 'slug-conflict', slugs }` (`OrgDeleteConflict`). A binding that returns nothing deletes as before.
  - The in-memory `ProjectBinding` checks slugs per org, and the binding conformance suite pins the per-org cases.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
