// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type ResourceRef, ref } from '@kindgi/authz';
import type { LiveScope, ProjectId, RunId, TenantId } from '@kindgi/types';

/**
 * What an approval is authorized on: its project, else its provenance run's
 * project, else the tenant. The approve/decide route resolves it from a
 * stored approval (its `projectId` and `provenanceRef.runId`); the proposal
 * service resolves the SAME ref for the approval a drafter's promotion WILL
 * open, so its separate-approver count admits exactly the reviewers the
 * decide route would let through. `getRun` is only consulted when a
 * run id is present and no project is set, so the proposal service — which
 * passes a project (or none) and never a run — may omit it.
 */
export async function approvalResourceRef(
  tenantId: TenantId,
  fields: { readonly projectId?: ProjectId | undefined; readonly runId?: RunId | undefined },
  getRun?: (tenantId: TenantId, runId: RunId) => Promise<{ readonly projectId: ProjectId } | null>,
): Promise<ResourceRef> {
  if (fields.projectId !== undefined) {
    return ref('project', fields.projectId as unknown as string);
  }
  if (fields.runId === undefined || getRun === undefined) {
    return ref('tenant', tenantId as unknown as string);
  }
  const run = await getRun(tenantId, fields.runId);
  return run === null
    ? ref('tenant', tenantId as unknown as string)
    : ref('project', run.projectId as unknown as string);
}

/**
 * A live scope's project: the project a promotion's approval is opened with
 * (a project or segment scope names one; a tenant or org scope names none),
 * and no provenance run. The proposal service feeds the result to
 * {@link approvalResourceRef} so its count resolves the resource the opened
 * approval will carry — not the eval run's project.
 */
export function projectOfScope(scope: LiveScope): ProjectId | undefined {
  return scope.kind === 'project' || scope.kind === 'segment' ? scope.projectId : undefined;
}
