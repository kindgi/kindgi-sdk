// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

import type { ToolContext } from './types.js';

/**
 * A context for calling a tool in a unit test: tenant `tenant-test`, run `run-test`, a signal
 * that never fires, and whatever you pass over them (`env`, `secrets`, `projectId`, …). The
 * TypeScript counterpart of Python's `ToolContext.for_test`.
 *
 * ```ts
 * const result = await invokeTool(findOrder, { orderId: 'ord_1001' }, toolContextForTest({
 *   env: { ORDERS_BASE_URL: 'https://orders.example.com' },
 * }));
 * ```
 */
export function toolContextForTest(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 'tenant-test' as TenantId,
    runId: 'run-test',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}
