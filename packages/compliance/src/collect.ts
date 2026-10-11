// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AuditEvent, AuditEventBinding, AuditEventFilter } from '@kindgi/audit-events';
import type { Result, TenantId } from '@kindgi/types';

import type { PersistenceError } from './errors.js';
import { auditEventToEvidence } from './generator.js';
import type { ComplianceEvidence, EvidenceFilter } from './types.js';

/** The page size `collectEvidence` reads with. */
export const EVIDENCE_EXPORT_PAGE_SIZE = 500;

/**
 * Every audit event an export's filter matches, as evidence records,
 * oldest first: what a signed compliance export carries. Reads the
 * binding page by page. An empty `evidenceKinds` matches nothing.
 */
export async function collectEvidence(
  auditEvents: AuditEventBinding,
  tenantId: TenantId,
  filter: EvidenceFilter,
): Promise<Result<readonly ComplianceEvidence[], PersistenceError>> {
  if (filter.evidenceKinds !== undefined && filter.evidenceKinds.length === 0) {
    return { kind: 'ok', value: [] };
  }
  const auditFilter = evidenceFilterToAuditFilter(filter);
  const events: AuditEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await auditEvents.query({
      tenantId,
      filter: auditFilter,
      ...(cursor !== undefined && { cursor }),
      limit: EVIDENCE_EXPORT_PAGE_SIZE,
    });
    if (page.kind === 'err') {
      const err = page.error;
      return {
        kind: 'err',
        error: {
          code: 'persistence-error',
          message:
            err.code === 'invalid-cursor'
              ? `pagination cursor rejected: ${err.message}`
              : err.message,
          cause: err.code === 'invalid-cursor' ? err : err.cause,
        },
      };
    }
    events.push(...page.value.data);
    if (page.value.nextCursor === undefined) break;
    cursor = page.value.nextCursor;
  }
  return { kind: 'ok', value: events.map(auditEventToEvidence) };
}

/**
 * An `EvidenceFilter` (the compliance surface) as an `AuditEventFilter`
 * (the store's): `runId`, `agentId` and `flowId` as they are,
 * `evidenceKind`/`evidenceKinds` as `kind`/`kinds`, the time bounds 1:1.
 */
export function evidenceFilterToAuditFilter(filter: EvidenceFilter): AuditEventFilter {
  return {
    ...(filter.runId !== undefined && { runId: filter.runId as unknown as string }),
    ...(filter.agentId !== undefined && { agentId: filter.agentId as unknown as string }),
    ...(filter.flowId !== undefined && { flowId: filter.flowId as unknown as string }),
    ...(filter.evidenceKind !== undefined && { kind: filter.evidenceKind }),
    ...(filter.evidenceKinds !== undefined && { kinds: filter.evidenceKinds }),
    ...(filter.from !== undefined && { from: filter.from as unknown as string }),
    ...(filter.to !== undefined && { to: filter.to as unknown as string }),
  };
}
