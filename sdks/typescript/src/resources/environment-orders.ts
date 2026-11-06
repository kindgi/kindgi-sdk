// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';
import type { Transport } from '../transport.js';

/**
 * The order a workspace runs a project through on its way to live — its
 * "environments". One ordered list of projects per parent: the workspace, or
 * one of its orgs. A read names a project the caller can't see by its
 * position alone (`projectId` absent); only a tenant admin writes one.
 */
export interface EnvironmentOrdersClient {
  /** The orders the caller can read a project in. @wire `GET /v1/environment-orders` */
  list(input?: EnvironmentOrdersListInput): Promise<EnvironmentOrderPage>;
  /** The workspace's own order (empty when unset). @wire `GET /v1/environment-orders/tenant` */
  getTenantOrder(): Promise<EnvironmentOrder>;
  /** Set the workspace's order (tenant admin). `[]` clears it. @wire `PUT /v1/environment-orders/tenant` */
  setTenantOrder(input: EnvironmentOrderSetInput): Promise<EnvironmentOrder>;
  /** An org's order. @wire `GET /v1/environment-orders/orgs/{orgId}` */
  getOrgOrder(orgId: string): Promise<EnvironmentOrder>;
  /** Set an org's order (tenant admin). `[]` clears it. @wire `PUT /v1/environment-orders/orgs/{orgId}` */
  setOrgOrder(orgId: string, input: EnvironmentOrderSetInput): Promise<EnvironmentOrder>;
}

export type EnvironmentOrderParent =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'org'; readonly orgId: string };

export interface EnvironmentOrderEntry {
  /** 0-based position in the order. */
  readonly position: number;
  /** Absent when the caller can't read the project at this position. */
  readonly projectId?: string;
}

export interface EnvironmentOrder {
  readonly parent: EnvironmentOrderParent;
  readonly entries: readonly EnvironmentOrderEntry[];
}

export interface EnvironmentOrdersListInput {
  readonly cursor?: Cursor;
  readonly limit?: number;
}

export interface EnvironmentOrderPage {
  readonly data: readonly EnvironmentOrder[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface EnvironmentOrderSetInput {
  /** The projects, in order. Empty clears the order. */
  readonly projectIds: readonly string[];
}

export function makeEnvironmentOrdersClient(transport: Transport): EnvironmentOrdersClient {
  return {
    list(input = {}) {
      return transport.request<EnvironmentOrderPage>({
        method: 'GET',
        path: '/v1/environment-orders',
        query: {
          ...(input.cursor !== undefined && { cursor: input.cursor as unknown as string }),
          ...(input.limit !== undefined && { limit: input.limit }),
        },
      });
    },
    getTenantOrder() {
      return transport.request<EnvironmentOrder>({
        method: 'GET',
        path: '/v1/environment-orders/tenant',
      });
    },
    setTenantOrder(input) {
      return transport.request<EnvironmentOrder>({
        method: 'PUT',
        path: '/v1/environment-orders/tenant',
        body: { projectIds: input.projectIds },
      });
    },
    getOrgOrder(orgId) {
      return transport.request<EnvironmentOrder>({
        method: 'GET',
        path: `/v1/environment-orders/orgs/${encodeURIComponent(orgId)}`,
      });
    },
    setOrgOrder(orgId, input) {
      return transport.request<EnvironmentOrder>({
        method: 'PUT',
        path: `/v1/environment-orders/orgs/${encodeURIComponent(orgId)}`,
        body: { projectIds: input.projectIds },
      });
    },
  };
}
