// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import type { EvalCaseStoreBinding, JudgedEvalCase } from '../../src/index.js';

/** An in-memory case store; the cursor is an offset. */
export function inMemoryCaseStore(): EvalCaseStoreBinding {
  const sets = new Map<string, readonly JudgedEvalCase[]>();
  const key = (suiteId: string, version: string) => `${suiteId}@${version}`;
  return {
    async putCases({ suiteId, version, cases }) {
      sets.set(key(suiteId, version), cases);
    },
    async listCases({ suiteId, version, cursor, limit }) {
      const all = sets.get(key(suiteId, version)) ?? [];
      const from = cursor === undefined ? 0 : Number(cursor);
      const data = all.slice(from, from + limit);
      const next = from + data.length;
      return {
        data,
        hasMore: next < all.length,
        ...(next < all.length && { nextCursor: String(next) as Cursor }),
      };
    },
  };
}
