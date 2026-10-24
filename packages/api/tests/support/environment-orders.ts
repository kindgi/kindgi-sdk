// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId } from '@kindgi/types';

import type { EnvironmentOrderBinding, EnvironmentOrderKey } from '../../src/index.js';

/**
 * A tenant's environment orders, each a list of projects in order, read
 * when `orderOf` is asked (so a test can set an order between calls). The
 * order routes' own methods aren't asked by the tests that use it.
 */
export function environmentOrders(
  orders: readonly (readonly ProjectId[])[],
): EnvironmentOrderBinding {
  const unused = async (): Promise<never> => {
    throw new Error('not asked in these tests');
  };
  return {
    list: unused,
    get: unused,
    set: unused,
    hasEnvironmentOrder: async () => orders.length > 0,
    async orderOf({ projectId }) {
      for (const [i, projects] of orders.entries()) {
        const position = projects.indexOf(projectId);
        if (position >= 0) {
          const orderId = `tenant:${i}` as EnvironmentOrderKey;
          return { orderId, parent: { kind: 'tenant' }, projects, position };
        }
      }
      return undefined;
    },
  };
}
