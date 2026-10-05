// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire-body serialization for `Scope` values.
 *
 * The `Scope` type from `@kindgi/platform` carries `tenantId` because
 * server-internal code (routes, bindings, storage adapters) needs it
 * everywhere the tuple flows. On the HTTP wire body, however, tenantId
 * is redundant: every route derives it authoritatively from the bearer
 * and any mismatched value is rejected as
 * `scope-mismatch 400`.
 *
 * Client callers rarely know their session tenantId ahead of time, and
 * a placeholder value would trip the mismatch check.
 * `scopeForBody(scope)` strips tenantId at the SDK boundary so request
 * bodies carry only the fields the server actually reads off the wire
 * (`kind` + `orgId`/`projectId`).
 *
 * Use this ONLY for request bodies. Query-string helpers (`scopeToQuery`)
 * already omit tenantId by construction and don't need this shim.
 */

/**
 * A scope, as the client takes it: the kind and its id. `tenantId` is
 * optional. The API derives the tenant from the bearer token, so the
 * client never sends it, and an app needn't know it. `@kindgi/platform`'s
 * `Scope`, which carries one, fits here as well.
 */
export type ScopeRef =
  | { readonly kind: 'tenant'; readonly tenantId?: string }
  | { readonly kind: 'org'; readonly orgId: string; readonly tenantId?: string }
  | { readonly kind: 'project'; readonly projectId: string; readonly tenantId?: string };

export function scopeForBody(scope: ScopeRef): Record<string, unknown> {
  if (scope.kind === 'tenant') return { kind: 'tenant' };
  if (scope.kind === 'org') return { kind: 'org', orgId: scope.orgId as unknown as string };
  return { kind: 'project', projectId: scope.projectId as unknown as string };
}

/**
 * Discriminated-pair scope wire encoding: `scopeKind` always; `scopeId`
 * present iff kind is `org` or `project`; tenant is implicit from the
 * session (Bearer token → tenant resolution). Used for the scope query
 * parameters and for bodies that carry the same pair (MCP register).
 */
export function scopeToQuery(scope: ScopeRef): { scopeKind: string; scopeId?: string } {
  if (scope.kind === 'tenant') return { scopeKind: 'tenant' };
  if (scope.kind === 'org') {
    return { scopeKind: 'org', scopeId: scope.orgId as unknown as string };
  }
  return { scopeKind: 'project', scopeId: scope.projectId as unknown as string };
}
