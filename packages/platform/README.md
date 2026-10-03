# @kindgi/platform

The multi-tenant hierarchy primitives — the type surface for
`Tenant → Org → Team → Project + User` plus the `Scope` discriminated
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

## Design directives

- **`Scope` is required + discriminated** — never optional `projectId`
  with tenant-fallback. Every write declares intent.
- **Content always has a project** — no nullable-`projectId` shape
  anywhere.
- **Users tenant-scoped.** Teams tenant-scoped. Orgs flat within tenant.
- **Team↔project many-to-many** via `TeamProjectGrant` (users join
  teams via `TeamMembership`).
- **Framework-owned team memberships** (no external directory sync).
