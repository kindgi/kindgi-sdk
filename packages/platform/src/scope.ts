// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `Scope` primitive — a required, discriminated access boundary.
 *
 * Design decision: a subset of framework resources —
 * those that describe policy, configuration, or authoring templates
 * rather than run-time content — carry a required, discriminated
 * `Scope` value that names the level at which the resource is
 * visible. The `Scope` is not a filter; it's a **row-level property**
 * recorded at insert time.
 *
 * Which resources carry `Scope` (vs `projectId`)?
 * - **Content-scoped** (agents, flows, tools, guardrails, memory
 *   facts, artifacts, runs, cost records, eval suites, eval runs,
 *   approvals, evidence, provenance, observations): a required
 *   `projectId`. Rows are the *contents* of a project.
 * - **Policy/config-scoped** (MCP endpoints, secrets, env values,
 *   pack templates, S3 credentials): `Scope` discriminated
 *   (Tenant / Org / Project). Describes *how* content is served —
 *   auth providers, credentials, template catalogs. A firm may want
 *   firm-wide MCP endpoints OR matter-scoped MCP endpoints; fixed to
 *   one level is wrong, nullable is worse.
 * - **Tenant-only** (adapters, capabilities, identity providers,
 *   deployment ledger, signing keys, tenant config): a required
 *   `tenantId` only. Deployment-wide framework configuration.
 *
 * Resolution semantics (most-specific-wins): for a resource lookup
 * within a request context that carries `{ tenantId, projectId }`,
 * walk `project → org → tenant` (the org is the project's `orgId`);
 * first match wins.
 */

import type { OrgId, ProjectId, TenantId } from '@kindgi/types';

export type Scope =
  | { readonly kind: 'tenant'; readonly tenantId: TenantId }
  | { readonly kind: 'org'; readonly tenantId: TenantId; readonly orgId: OrgId }
  | { readonly kind: 'project'; readonly tenantId: TenantId; readonly projectId: ProjectId };

export function scopeKey(s: Scope): string {
  switch (s.kind) {
    case 'tenant':
      return `tenant:${s.tenantId}`;
    case 'org':
      return `org:${s.orgId}`;
    case 'project':
      return `project:${s.projectId}`;
  }
}
