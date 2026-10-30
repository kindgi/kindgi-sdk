// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import type { CorrectedEvalCase, EvalCaseStoreBinding } from '../../src/index.js';

/** An in-memory case store; the cursor is an offset. */
export function inMemoryCaseStore(): EvalCaseStoreBinding {
  const sets = new Map<string, readonly CorrectedEvalCase[]>();
  const key = (testSetId: string, version: string) => `${testSetId}@${version}`;
  return {
    async putCases({ testSetId, version, cases }) {
      sets.set(key(testSetId, version), cases);
    },
    async listCases({ testSetId, version, cursor, limit }) {
      const all = sets.get(key(testSetId, version)) ?? [];
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
