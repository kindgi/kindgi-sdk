# @kindgi/platform

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
