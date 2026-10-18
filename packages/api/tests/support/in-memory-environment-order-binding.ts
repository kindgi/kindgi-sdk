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
  EnvironmentOrderCursor,
  EnvironmentOrderGetInput,
  EnvironmentOrderKey,
  EnvironmentOrderListInput,
  EnvironmentOrderListPage,
  EnvironmentOrderLocation,
  EnvironmentOrderOfInput,
  EnvironmentOrderParent,
  EnvironmentOrderSetInput,
  EnvironmentOrderSetOutcome,
  HasEnvironmentOrderInput,
} from '../../src/environment-orders-binding.js';

function orderKey(tenantId: TenantId, parent: EnvironmentOrderParent): EnvironmentOrderKey {
  const key = parent.kind === 'org' ? `org:${parent.orgId}` : `tenant:${tenantId}`;
  return key as EnvironmentOrderKey;
}

/** A parent as a page cursor: its org, or `null` for the tenant's own. */
function cursorOf(parent: EnvironmentOrderParent): EnvironmentOrderCursor {
  return { orgId: parent.kind === 'org' ? parent.orgId : null };
}

/** The durable binding's listing order: the tenant's own first, then its orgs by id. */
function compareCursors(a: EnvironmentOrderCursor, b: EnvironmentOrderCursor): number {
  if (a.orgId === b.orgId) return 0;
  if (a.orgId === null) return -1;
  if (b.orgId === null) return 1;
  return a.orgId < b.orgId ? -1 : 1;
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
      const { after } = input;
      const rest = tenantOrders(input.tenantId)
        .filter((o) => after === undefined || compareCursors(cursorOf(o.parent), after) > 0)
        .sort((a, b) => compareCursors(cursorOf(a.parent), cursorOf(b.parent)));
      const page = rest.slice(0, input.limit);
      const last = page.at(-1);
      return {
        orders: page.map(toOrder),
        ...(rest.length > page.length && last !== undefined
          ? { nextAfter: cursorOf(last.parent) }
          : {}),
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
