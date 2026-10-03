// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type ResourceRef, ref } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { OrgId, ProjectId, TenantId } from '@kindgi/types';

/**
 * The authorization resource for a request scope: the project or org it
 * names, else the tenant. A route's authorization middleware derives the
 * scope with the same parser as its handler and passes the result here, so
 * the scope that is checked is the scope that is acted on. An absent or
 * unparseable scope checks the tenant, the strictest resource; the handler
 * then rejects the request.
 */
export function scopeResourceRef(scope: Scope | undefined, tenantId: TenantId): ResourceRef {
  if (scope?.kind === 'project') return ref('project', scope.projectId as unknown as string);
  if (scope?.kind === 'org') return ref('org', scope.orgId as unknown as string);
  return ref('tenant', tenantId as unknown as string);
}

/** {@link scopeResourceRef} for the `?scopeKind` + `?scopeId` query parameters. */
export function queryScopeResourceRef(
  query: QuerySource,
  session: { readonly tenantId: TenantId },
): ResourceRef {
  const parsed = parseScopeParams(query, session);
  return scopeResourceRef(parsed.kind === 'ok' ? parsed.scope : undefined, session.tenantId);
}

/**
 * Outcome of parsing the `?scopeKind + ?scopeId + ?inherit` triplet.
 * `ok` carries the decoded `Scope` (undefined if no scope params were
 * supplied) plus the parsed `inherit` boolean (undefined if elided —
 * caller leaves the binding to apply its own default).
 */
export type ParseScopeParamsOutcome =
  | { readonly kind: 'ok'; readonly scope?: Scope; readonly inherit?: boolean }
  | { readonly kind: 'err'; readonly message: string };

type QuerySource = Record<string, string> | ((name: string) => string | undefined);

/**
 * Parse the `?scopeKind + ?scopeId + ?inherit` triplet. The wire shape
 * is a discriminated triplet by design — human-readable, curl / browser
 * / access-log auditable for regulated verticals.
 *
 * Cross-field validation (all return 400 `scope-invalid`):
 * - `scopeKind === 'tenant' && scopeId !== undefined` → err (tenant carries no id).
 * - `scopeKind in {'org','project'} && scopeId === undefined` → err (missing id).
 * - `scopeKind === undefined && scopeId !== undefined` → err (orphan id).
 * - `inherit` — accepts literal 'true' / 'false' strings; anything else → err.
 *
 * `tenantId` for the decoded Scope always comes from the session —
 * cross-tenant scopes are denied by policy.
 *
 * `inherit` is load-bearing for policy/config-scoped bindings
 * (e.g. MCP endpoints, secrets, env values) — controls the
 * upward-hierarchy walk. For content-scoped bindings the flag is a
 * documented no-op; the route passes it through so the binding-side
 * field-passthrough shape stays uniform across the scope-aware
 * bindings.
 */
export function parseScopeParams(
  query: QuerySource,
  session: { readonly tenantId: TenantId },
): ParseScopeParamsOutcome {
  const get: (n: string) => string | undefined =
    typeof query === 'function' ? query : (n: string) => query[n];
  const scopeKindRaw = get('scopeKind');
  const scopeIdRaw = get('scopeId');
  const inheritRaw = get('inherit');

  // ---- inherit ----
  let inherit: boolean | undefined;
  if (inheritRaw !== undefined && inheritRaw.length > 0) {
    if (inheritRaw === 'true') inherit = true;
    else if (inheritRaw === 'false') inherit = false;
    else {
      return {
        kind: 'err',
        message: `scope query parameters malformed: inherit must be 'true' or 'false', got "${inheritRaw}"`,
      };
    }
  }

  // ---- scope triplet ----
  if (scopeKindRaw === undefined || scopeKindRaw.length === 0) {
    if (scopeIdRaw !== undefined && scopeIdRaw.length > 0) {
      return {
        kind: 'err',
        message: `scope query parameters malformed: scopeId="${scopeIdRaw}" requires scopeKind`,
      };
    }
    return { kind: 'ok', ...(inherit !== undefined && { inherit }) };
  }

  if (scopeKindRaw !== 'tenant' && scopeKindRaw !== 'org' && scopeKindRaw !== 'project') {
    return {
      kind: 'err',
      message: `scope query parameters malformed: scopeKind must be one of 'tenant' | 'org' | 'project', got "${scopeKindRaw}"`,
    };
  }

  if (scopeKindRaw === 'tenant') {
    if (scopeIdRaw !== undefined && scopeIdRaw.length > 0) {
      return {
        kind: 'err',
        message: `scope query parameters malformed: scopeKind='tenant' takes no scopeId (tenant is implicit from the session)`,
      };
    }
    return {
      kind: 'ok',
      scope: { kind: 'tenant', tenantId: session.tenantId },
      ...(inherit !== undefined && { inherit }),
    };
  }

  // 'org' | 'project' — both require scopeId
  if (scopeIdRaw === undefined || scopeIdRaw.length === 0) {
    return {
      kind: 'err',
      message: `scope query parameters malformed: scopeKind='${scopeKindRaw}' requires scopeId`,
    };
  }

  const scope: Scope =
    scopeKindRaw === 'org'
      ? { kind: 'org', tenantId: session.tenantId, orgId: scopeIdRaw as OrgId }
      : { kind: 'project', tenantId: session.tenantId, projectId: scopeIdRaw as ProjectId };

  return { kind: 'ok', scope, ...(inherit !== undefined && { inherit }) };
}
