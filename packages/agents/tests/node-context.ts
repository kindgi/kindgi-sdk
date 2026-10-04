// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeContext } from '@kindgi/handler';
import type { RunId } from '@kindgi/types';

/**
 * A node context for a handler under test: the fields given, and `record`
 * kept in `records` as a runtime journals it. Pass the same `records` to
 * the context of a step that runs again (resumed after a wait), and it
 * reads its decisions back.
 */
export function testNodeContext(
  fields: Partial<NodeContext> & { readonly runId: RunId },
  records: Map<string, unknown> = new Map(),
): NodeContext {
  return {
    async record<T>(key: string, decide: () => T | Promise<T>): Promise<T> {
      if (records.has(key)) return records.get(key) as T;
      const value = await decide();
      if (value !== undefined) records.set(key, value);
      return value;
    },
    ...fields,
  } as unknown as NodeContext;
}
