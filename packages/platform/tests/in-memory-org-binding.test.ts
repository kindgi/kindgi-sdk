// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire the shared `runOrgBindingConformance` suite against the
 * in-memory reference adapter.
 */

import type { OrgId, TenantId } from '@kindgi/types';

import { makeInMemoryOrgBinding } from '../src/in-memory/org-binding.js';
import { runOrgBindingConformance } from './org-binding.conformance.js';

runOrgBindingConformance(makeInMemoryOrgBinding, 'InMemoryOrgBinding', {
  makeGuardedBinding: () => {
    // The order each org is the parent of, keyed by tenant + org: the test's
    // own store, which the binding reads through `environmentOrderOf` — the
    // in-memory stand-in for a `project_stages` row.
    const orders = new Map<string, string>();
    const key = (tenantId: TenantId, orgId: OrgId) => `${tenantId}::${orgId}`;
    const binding = makeInMemoryOrgBinding({
      environmentOrderOf: (tenantId, orgId) => orders.get(key(tenantId, orgId)),
    });
    return {
      binding,
      putInEnvironmentOrder: async (tenantId: TenantId, orgId: OrgId) => {
        const orderId = `org:${orgId}`;
        orders.set(key(tenantId, orgId), orderId);
        return orderId;
      },
      clearEnvironmentOrder: async (tenantId: TenantId, orgId: OrgId) => {
        orders.delete(key(tenantId, orgId));
      },
    };
  },
});
