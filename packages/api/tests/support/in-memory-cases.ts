// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import type { CorrectedEvalCase, EvalCaseStoreBinding } from '../../src/index.js';

/** An in-memory case store, and the run each case was stored with; the cursor is an offset. */
export interface InMemoryCaseStore extends EvalCaseStoreBinding {
  /** The `runId` a case was stored with, which a read never answers. */
  runIdOf(testSetId: string, version: string, caseId: string): string | undefined;
}

export function inMemoryCaseStore(): InMemoryCaseStore {
  const sets = new Map<string, readonly CorrectedEvalCase[]>();
  const runIds = new Map<string, string>();
  const key = (testSetId: string, version: string) => `${testSetId}@${version}`;
  return {
    async putCases({ testSetId, version, cases }) {
      sets.set(
        key(testSetId, version),
        cases.map(({ runId, ...c }) => {
          if (runId !== undefined) runIds.set(`${key(testSetId, version)}/${c.caseId}`, runId);
          return c;
        }),
      );
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
    runIdOf(testSetId, version, caseId) {
      return runIds.get(`${key(testSetId, version)}/${caseId}`);
    },
  };
}
