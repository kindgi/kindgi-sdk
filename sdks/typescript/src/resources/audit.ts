// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Audit — authorization-decision readback.
 *
 * @wire /v1/audit/authz  (packages/api/src/routes/audit.ts)
 *
 * Every route-level authz `check()` in the framework emits an
 * `authz-decision` audit event via the unified `AuditEventBinding`
 * (`@kindgi/audit-events`). This resource pages through them with the
 * standard filter matrix. Admin@tenant only.
 */

import type { Transport } from '../transport.js';

export interface AuthzDecisionEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly timestamp: string;
  readonly actorSubject: string;
  readonly onBehalfSubject?: string;
  readonly action: string;
  readonly resource: string;
  readonly outcome: 'allowed' | 'denied';
  readonly reason: string;
  readonly failing?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly runId?: string;
  readonly latencyMs?: number;
}

export interface AuthzDecisionPage {
  readonly data: readonly AuthzDecisionEvent[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ListAuthzDecisionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly actorSubject?: string;
  readonly onBehalfOf?: string;
  readonly action?: string;
  readonly resource?: string;
  readonly outcome?: 'allowed' | 'denied';
  readonly runId?: string;
  readonly from?: string;
  readonly to?: string;
  /** `asc` (absent): oldest first. `desc`: newest first. */
  readonly order?: 'asc' | 'desc';
}

export interface AuthzAuditClient {
  /** @wire GET /v1/audit/authz */
  list(filter?: ListAuthzDecisionsFilter): Promise<AuthzDecisionPage>;
}

export interface AuditResourceClient {
  readonly authz: AuthzAuditClient;
}

export function makeAuditClient(transport: Transport): AuditResourceClient {
  return {
    authz: {
      async list(filter) {
        return transport.request<AuthzDecisionPage>({
          method: 'GET',
          path: '/v1/audit/authz',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.actorSubject !== undefined && { actorSubject: filter.actorSubject }),
            ...(filter?.onBehalfOf !== undefined && { onBehalfOf: filter.onBehalfOf }),
            ...(filter?.action !== undefined && { action: filter.action }),
            ...(filter?.resource !== undefined && { resource: filter.resource }),
            ...(filter?.outcome !== undefined && { outcome: filter.outcome }),
            ...(filter?.runId !== undefined && { runId: filter.runId }),
            ...(filter?.from !== undefined && { from: filter.from }),
            ...(filter?.to !== undefined && { to: filter.to }),
            ...(filter?.order !== undefined && { order: filter.order }),
          },
        });
      },
    },
  };
}
