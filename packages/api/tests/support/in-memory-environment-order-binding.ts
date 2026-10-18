// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `makeInMemoryEnvironmentOrderBinding` — a reference in-memory
 * `EnvironmentOrderBinding` for route tests and dev servers. It holds each
 * tenant's orders in a map. It does NOT verify that a project is live in the
 * tenant under the order's parent (it has no project store) — the durable
 * binding does that under its lock. Compose its `orderOf` to an in-memory
 * `ProjectBinding`'s `environmentOrderOf` hook so the project guard sees the
 * orders this binding holds.
 */

import type { ProjectId, TenantId } from '@kindgi/types';

import type {
  EnvironmentOrder,
  EnvironmentOrderBinding,
  EnvironmentOrderGetInput,
  EnvironmentOrderListInput,
  EnvironmentOrderListPage,
  EnvironmentOrderLocation,
  EnvironmentOrderOfInput,
  EnvironmentOrderParent,
  EnvironmentOrderSetInput,
  EnvironmentOrderSetOutcome,
  HasEnvironmentOrderInput,
} from '../../src/environment-orders-binding.js';

function orderKey(tenantId: TenantId, parent: EnvironmentOrderParent): string {
  return parent.kind === 'org' ? `org:${parent.orgId}` : `tenant:${tenantId}`;
}

interface StoredOrder {
  readonly tenantId: TenantId;
  readonly parent: EnvironmentOrderParent;
  readonly projectIds: readonly ProjectId[];
}

export function makeInMemoryEnvironmentOrderBinding(): EnvironmentOrderBinding {
  // One entry per (tenant, parent), keyed `${tenantId}::${orderKey}`.
  const orders = new Map<string, StoredOrder>();
  const storeKey = (tenantId: TenantId, parent: EnvironmentOrderParent): string =>
    `${tenantId}::${orderKey(tenantId, parent)}`;

  const toOrder = (stored: StoredOrder): EnvironmentOrder => ({
    parent: stored.parent,
    entries: stored.projectIds.map((projectId, position) => ({ position, projectId })),
  });

  const tenantOrders = (tenantId: TenantId): StoredOrder[] =>
    [...orders.values()].filter((o) => o.tenantId === tenantId && o.projectIds.length > 0);

  function inAnotherOrder(tenantId: TenantId, key: string, projectId: ProjectId): boolean {
    for (const [otherKey, other] of orders) {
      if (otherKey === key || other.tenantId !== tenantId) continue;
      if (other.projectIds.includes(projectId)) return true;
    }
    return false;
  }

  return {
    async list(input: EnvironmentOrderListInput): Promise<EnvironmentOrderListPage> {
      const all = tenantOrders(input.tenantId)
        .sort((a, b) =>
          orderKey(input.tenantId, a.parent).localeCompare(orderKey(input.tenantId, b.parent)),
        )
        .map(toOrder);
      const start = input.after === undefined ? 0 : Number.parseInt(input.after, 10) || 0;
      const next = start + input.limit;
      return {
        orders: all.slice(start, next),
        ...(next < all.length ? { nextCursor: String(next) } : {}),
      };
    },

    async get(input: EnvironmentOrderGetInput): Promise<EnvironmentOrder> {
      const stored = orders.get(storeKey(input.tenantId, input.parent));
      return stored === undefined ? { parent: input.parent, entries: [] } : toOrder(stored);
    },

    async set(input: EnvironmentOrderSetInput): Promise<EnvironmentOrderSetOutcome> {
      const key = storeKey(input.tenantId, input.parent);
      const before = orders.get(key)?.projectIds ?? [];
      const seen = new Set<ProjectId>();
      for (const id of input.projectIds) {
        if (seen.has(id)) {
          return {
            kind: 'bad-input',
            message: `Project "${id as unknown as string}" is named more than once`,
          };
        }
        seen.add(id);
        if (inAnotherOrder(input.tenantId, key, id)) {
          return {
            kind: 'project-in-another-order',
            projectId: id,
            message: `Project "${id as unknown as string}" is already in another order`,
          };
        }
      }
      const after = [...input.projectIds];
      const stored: StoredOrder = {
        tenantId: input.tenantId,
        parent: input.parent,
        projectIds: after,
      };
      if (before.length === after.length && before.every((id, i) => id === after[i])) {
        return { kind: 'no-op', order: toOrder(stored) };
      }
      if (after.length === 0) orders.delete(key);
      else orders.set(key, stored);
      return { kind: 'ok', order: toOrder(stored), before: [...before], after };
    },

    async orderOf(input: EnvironmentOrderOfInput): Promise<EnvironmentOrderLocation | undefined> {
      for (const order of tenantOrders(input.tenantId)) {
        const position = order.projectIds.indexOf(input.projectId);
        if (position >= 0) {
          return {
            orderId: orderKey(input.tenantId, order.parent),
            parent: order.parent,
            projects: [...order.projectIds],
            position,
          };
        }
      }
      return undefined;
    },

    async hasEnvironmentOrder(input: HasEnvironmentOrderInput): Promise<boolean> {
      return tenantOrders(input.tenantId).length > 0;
    },
  };
}
