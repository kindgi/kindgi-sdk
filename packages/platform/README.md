# @kindgi/platform

The multi-tenant hierarchy primitives — the type surface for
`Workspace → Org → Team → Project + User` plus the `Scope` discriminated
access-boundary.

## Status

This package ships the primitive **types** — pure shapes, zero
validation — plus the binding interfaces (`OrgBinding`, `TeamBinding`,
`ProjectBinding`, `TeamProjectGrantBinding`, `TenantHierarchyBinding`)
and reference in-memory adapters. Durable implementations are supplied
by the deployment; the HTTP routes live in `@kindgi/api`. Authorization
vocabulary and helpers live in `@kindgi/authz`.

## What's here

- `src/scope.ts` — the `Scope` discriminated union
  (`tenant | org | project`) + the `scopeKey()` helper.
- `src/types.ts` — the primitive shapes: `Org`/`OrgSpec`/`OrgPatch`,
  `Team`/`TeamSpec`/`TeamPatch`, `TeamMembership`, `TeamRole`,
  `Project`/`ProjectSpec`/`ProjectPatch`, `ProjectMembership`,
  `ProjectRole`.
- `src/*-binding.ts` — the binding interfaces (plus the
  `TenantHierarchyBinding` params / error shapes and `TenantSummary`).
- `src/in-memory/` — reference in-memory adapters (dev + tests).
- `src/index.ts` — re-exports all of the above.

All branded IDs (`TenantId`, `UserId`, `OrgId`, `TeamId`, `ProjectId`)
come from `@kindgi/types` — this package adds no new IDs. `Scope` is deliberately in its own file (separate from
`types.ts`) so binding-interface files stay clean of the primitive-type
file.

## Outcomes, not exceptions

A write the caller can get wrong resolves to an outcome — a union
discriminated on `kind`, `'ok'` on success — and never rejects for it. A
rejected promise means the backend failed.

| Method | Outcomes besides `ok` |
|---|---|
| `OrgBinding.create` | `slug-conflict` |
| `OrgBinding.update` | `org-not-found`, `slug-conflict` |
| `TeamBinding.create` | `slug-conflict` |
| `TeamBinding.update` | `team-not-found`, `slug-conflict` |
| `TeamMembershipBinding.add` | `team-not-found` |
| `TeamMembershipBinding.updateRole` | `team-not-found`, `team-membership-not-found` |
| `ProjectBinding.create` | `slug-conflict`, `project-default-already-exists`, `project-test-already-exists` |
| `ProjectBinding.update` | `project-not-found`, `slug-conflict` |
| `ProjectMembershipBinding.add` | `project-not-found` |
| `ProjectMembershipBinding.updateRole` | `project-not-found`, `project-membership-not-found` |

An org's and a team's slug are unique within the workspace; a project's
within its org, and a project without an org's among the workspace's
projects without one (two orgs may each have a project with the same
slug). `OrgBinding.delete` may answer `slug-conflict` when the org's
projects, left without an org, would take a slug a project without one
already has (the Kindgi runtime's storage does; the in-memory adapter
doesn't detach projects). Each
`kind` is also the error code the `@kindgi/api` routes answer with: a
`slug-conflict`, `project-default-already-exists` or
`project-test-already-exists` is a `409`, a `*-not-found` a `404`. The
conformance suites in `tests/` pin every outcome.

`project-test-already-exists` comes from a binding that keeps test
projects (`ProjectBinding.keepsTestProjects`): a second test project for
the same person in the workspace. A binding without the marker isn't
given one: the API answers `501 project-test-unsupported` first.

## Design directives

- **`Scope` is required + discriminated** — never optional `projectId`
  with workspace-fallback. Every write declares intent.
- **Content always has a project** — no nullable-`projectId` shape
  anywhere.
- **Users workspace-scoped.** Teams workspace-scoped. Orgs flat within workspace.
- **Team↔project many-to-many** via `TeamProjectGrant` (users join
  teams via `TeamMembership`).
- **Framework-owned team memberships** (no external directory sync).
