// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { UsagePage as UsagePageWire } from '../generated/api.js';
import type { Transport } from '../transport.js';

/** A page of usage groups, with its `watermark` and, when there are more, `nextCursor`. */
export type UsagePage = UsagePageWire;
/** One group: the dimensions grouped by, then `count`, `quantity`, `firstAt` and `lastAt`. */
export type UsageGroup = UsagePageWire['data'][number];

/** What a workspace's own read groups by. */
export type UsageGroupKey = 'project' | 'agent' | 'kind' | 'class' | 'state' | 'day';

/** What to read: a window (`to` excluded, at most 92 days), how to group it, and filters. */
export interface UsageQuery {
  /** A time with a zone, such as `2026-11-01T00:00:00Z`. */
  readonly from: string;
  readonly to: string;
  /** Default `['project', 'kind']`. */
  readonly groupBy?: readonly UsageGroupKey[];
  readonly kind?: readonly string[];
  readonly class?: readonly string[];
  readonly state?: readonly string[];
  /** Only this project. One you can't read gives an empty answer. */
  readonly projectId?: string;
  /** Groups a page: 1 to 10000, default 1000. */
  readonly limit?: number;
  /** The previous page's `nextCursor`. */
  readonly cursor?: string;
}

/** The operator's read: grouped by `tenant` too, and one tenant's only with `tenantId`. */
export interface SystemUsageQuery extends Omit<UsageQuery, 'groupBy' | 'projectId'> {
  /** Default `['tenant', 'kind']`. */
  readonly groupBy?: readonly (UsageGroupKey | 'tenant')[];
  readonly tenantId?: string;
}

/**
 * Your workspace's usage, aggregated: counts, sums and first and last
 * times, over the projects you may read. Never a record's content.
 */
export interface TenantUsageClient {
  /**
   * One page of groups, with the `watermark`: every record at or before it
   * is in the answer. Pass `nextCursor` back as `cursor` for the next page.
   *
   * @wire `GET /v1/usage`
   */
  read(query: UsageQuery): Promise<UsagePage>;
}

/**
 * Usage across tenants, aggregated, for the operator: a test tenant's and
 * one whose setup is pending are never in it. Takes `system:usage:read`.
 */
export interface SystemUsageClient {
  /**
   * One page of groups, with the `watermark`. Pass `nextCursor` back as
   * `cursor` for the next page.
   *
   * @wire `GET /v1/system/usage`
   */
  read(query: SystemUsageQuery): Promise<UsagePage>;
}

export function makeTenantUsageClient(transport: Transport): TenantUsageClient {
  return {
    async read(query) {
      return transport.request<UsagePage>({
        method: 'GET',
        path: '/v1/usage',
        query: {
          ...queryOf(query),
          ...(query.projectId !== undefined && { projectId: query.projectId }),
        },
      });
    },
  };
}

export function makeSystemUsageClient(transport: Transport): SystemUsageClient {
  return {
    async read(query) {
      return transport.request<UsagePage>({
        method: 'GET',
        path: '/v1/system/usage',
        query: {
          ...queryOf(query),
          ...(query.tenantId !== undefined && { tenantId: query.tenantId }),
        },
      });
    },
  };
}

/** The query both reads take, lists comma-separated. */
function queryOf(query: UsageQuery | SystemUsageQuery): Record<string, string | number> {
  const list = (values: readonly string[] | undefined) =>
    values === undefined || values.length === 0 ? undefined : values.join(',');
  const groupBy = list(query.groupBy);
  const kind = list(query.kind);
  const cls = list(query.class);
  const state = list(query.state);
  return {
    from: query.from,
    to: query.to,
    ...(groupBy !== undefined && { groupBy }),
    ...(kind !== undefined && { kind }),
    ...(cls !== undefined && { class: cls }),
    ...(state !== undefined && { state }),
    ...(query.limit !== undefined && { limit: query.limit }),
    ...(query.cursor !== undefined && { cursor: query.cursor }),
  };
}
