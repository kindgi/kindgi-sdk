// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  SystemUsagePage as SystemUsagePageWire,
  TenantLimitsResult,
  TenantLimits as TenantLimitsWire,
  TenantProductionAllowed,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type TenantLimitsShape = TenantLimitsWire;
export type SystemUsagePage = SystemUsagePageWire;
export type SystemUsageGroup = SystemUsagePageWire['data'][number];

/**
 * What the control plane sets on a tenant, with a system key (`kgi_sy_…`)
 * holding the route's scope. A tenant's own key gets 403
 * (`system-principal-required`); a key without the scope,
 * `system-scope-missing`. A closing tenant answers `409 tenant-closing`.
 */
export interface SystemTenantsClient {
  /**
   * Allow the tenant to put projects in production (`true`), or stop it
   * (`false`): the switch the production gate reads. Takes
   * `system:tenants:production`.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/production-allowed`
   */
  setProductionAllowed(
    tenantId: string,
    allowed: boolean,
    options?: { readonly idempotencyKey?: string },
  ): Promise<TenantProductionAllowed>;
  /**
   * Replace the tenant's limits with exactly these: a limit left out isn't
   * set, and isn't enforced. Takes `system:tenants:limits`.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/limits`
   */
  setLimits(
    tenantId: string,
    limits: TenantLimitsShape,
    options?: { readonly idempotencyKey?: string },
  ): Promise<TenantLimitsResult>;
}

/** What to read: a window (`to` excluded, at most 92 days), how to group it, and filters. */
export interface SystemUsageQuery {
  readonly from: string;
  readonly to: string;
  /** Default `['tenant', 'kind']`. */
  readonly groupBy?: readonly (
    | 'tenant'
    | 'project'
    | 'agent'
    | 'kind'
    | 'class'
    | 'state'
    | 'day'
  )[];
  readonly kind?: readonly string[];
  readonly class?: readonly string[];
  readonly state?: readonly ('on' | 'off')[];
  readonly tenantId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Usage across tenants, aggregated: counts, sums and first and last times,
 * never a record's content. Takes `system:usage:read`.
 */
export interface SystemUsageClient {
  /**
   * One page of groups, with the `watermark`: every record at or before it
   * is in the answer. Pass `nextCursor` back as `cursor` for the next page.
   *
   * @wire `GET /v1/system/usage`
   */
  read(query: SystemUsageQuery): Promise<SystemUsagePage>;
}

export function makeSystemTenantsClient(transport: Transport): SystemTenantsClient {
  return {
    async setProductionAllowed(tenantId, allowed, options) {
      return transport.request<TenantProductionAllowed>({
        method: 'PUT',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/production-allowed`,
        body: { allowed },
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async setLimits(tenantId, limits, options) {
      return transport.request<TenantLimitsResult>({
        method: 'PUT',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/limits`,
        body: limits,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}

export function makeSystemUsageClient(transport: Transport): SystemUsageClient {
  const list = (values: readonly string[] | undefined) =>
    values === undefined || values.length === 0 ? undefined : values.join(',');
  return {
    async read(query) {
      const groupBy = list(query.groupBy);
      const kind = list(query.kind);
      const cls = list(query.class);
      const state = list(query.state);
      return transport.request<SystemUsagePage>({
        method: 'GET',
        path: '/v1/system/usage',
        query: {
          from: query.from,
          to: query.to,
          ...(groupBy !== undefined && { groupBy }),
          ...(kind !== undefined && { kind }),
          ...(cls !== undefined && { class: cls }),
          ...(state !== undefined && { state }),
          ...(query.tenantId !== undefined && { tenantId: query.tenantId }),
          ...(query.limit !== undefined && { limit: query.limit }),
          ...(query.cursor !== undefined && { cursor: query.cursor }),
        },
      });
    },
  };
}
