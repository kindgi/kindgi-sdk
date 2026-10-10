// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Audit — authorization-decision readback.
 *
 * @wire /v1/audit/authz, /v1/audit/sign-ins  (packages/api/src/routes/audit.ts)
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

/** One sign-in audit event, flattened (`GET /v1/audit/sign-ins`). */
export interface SignInEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly kind:
    | 'signed-in'
    | 'signed-out'
    | 'sign-in-refused'
    | 'sign-in-link-sent'
    | 'sign-in-link-capped'
    | 'sessions-revoked'
    | 'sessions-ended';
  readonly outcome: string;
  /** The person: who signed in or out, or whom a link was for. Absent on a refusal. */
  readonly userId?: string;
  /** How: `api-token`, `email-link`, `google`, `microsoft`, `github`, or a workspace identity provider's id. */
  readonly method?: string;
  readonly clientAddress?: string;
  /** Why a sign-in was refused, or which limit held. */
  readonly reason?: string;
  readonly sessionId?: string;
}

export interface SignInEventPage {
  readonly data: readonly SignInEvent[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ListSignInsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /** One person's own sign-ins and sign-outs. */
  readonly userId?: string;
  readonly kind?: SignInEvent['kind'];
  readonly from?: string;
  readonly to?: string;
  /** `asc` (absent): oldest first. `desc`: newest first. */
  readonly order?: 'asc' | 'desc';
}

export interface SignInAuditClient {
  /** @wire GET /v1/audit/sign-ins — a tenant admin's to read. */
  list(filter?: ListSignInsFilter): Promise<SignInEventPage>;
}

export interface AuthzAuditClient {
  /** @wire GET /v1/audit/authz */
  list(filter?: ListAuthzDecisionsFilter): Promise<AuthzDecisionPage>;
}

export interface AuditResourceClient {
  readonly authz: AuthzAuditClient;
  /** The tenant's sign-in history. */
  readonly signIns: SignInAuditClient;
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
    signIns: {
      async list(filter) {
        return transport.request<SignInEventPage>({
          method: 'GET',
          path: '/v1/audit/sign-ins',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.userId !== undefined && { userId: filter.userId }),
            ...(filter?.kind !== undefined && { kind: filter.kind }),
            ...(filter?.from !== undefined && { from: filter.from }),
            ...(filter?.to !== undefined && { to: filter.to }),
            ...(filter?.order !== undefined && { order: filter.order }),
          },
        });
      },
    },
  };
}
