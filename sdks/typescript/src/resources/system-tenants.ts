// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  TenantLimitsResult,
  TenantLimits as TenantLimitsWire,
  TenantProductionAllowed,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type TenantLimitsShape = TenantLimitsWire;

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
