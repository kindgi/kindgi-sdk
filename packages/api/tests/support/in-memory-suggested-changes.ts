// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type { SuggestedChangeId, Timestamp } from '@kindgi/types';

import type { StoredSuggestedChange, SupervisorBinding } from '../../src/index.js';

/**
 * The suggested changes half of a `SupervisorBinding` in memory, keeping the
 * contract a store keeps: newest first, dedup by fingerprint among
 * suggested changes not withdrawn, and each recorded step a compare-and-set on
 * `revision` (an `evaluation` clears `pinChangeId`). `before` runs before
 * each record, so a test can slip a competing write in.
 */
export function inMemorySuggestedChanges(): SupervisorBinding & {
  readonly rows: Map<string, StoredSuggestedChange>;
  before: (() => void) | undefined;
} {
  const rows = new Map<string, StoredSuggestedChange>();
  let clock = Date.parse('2026-10-07T00:00:00.000Z');
  const now = () => {
    clock += 1000;
    return new Date(clock).toISOString() as Timestamp;
  };
  const store = {
    rows,
    before: undefined as (() => void) | undefined,
    async listSuggestedChanges({ tenantId, limit, cursor, agentId, tier, pinnedScope }) {
      const all = [...rows.values()]
        .filter((p) => p.tenantId === tenantId)
        .filter((p) => agentId === undefined || p.agentId === agentId)
        .filter((p) => tier === undefined || p.tier === tier)
        .filter(
          (p) =>
            pinnedScope === undefined || JSON.stringify(p.scope) === JSON.stringify(pinnedScope),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const at = cursor === undefined ? 0 : Number(cursor);
      const data = all.slice(at, at + limit);
      return at + limit < all.length ? { data, nextCursor: String(at + limit) as never } : { data };
    },
    async getSuggestedChange({ tenantId, suggestedChangeId }) {
      const p = rows.get(suggestedChangeId as unknown as string);
      return p !== undefined && p.tenantId === tenantId ? p : null;
    },
    async createSuggestedChange(input) {
      const same = [...rows.values()].find(
        (p) =>
          p.tenantId === input.tenantId &&
          p.fingerprint === input.fingerprint &&
          p.withdrawn === undefined,
      );
      if (same !== undefined) return { kind: 'dedup', suggestedChange: same };
      const at = now();
      const suggestedChange: StoredSuggestedChange = {
        ...input,
        id: randomUUID() as SuggestedChangeId,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      rows.set(suggestedChange.id as unknown as string, suggestedChange);
      return { kind: 'ok', suggestedChange };
    },
    async recordSuggestedChange({ tenantId, suggestedChangeId, expectRevision, step }) {
      store.before?.();
      const p = rows.get(suggestedChangeId as unknown as string);
      if (p === undefined || p.tenantId !== tenantId) return { kind: 'not-found' };
      if (p.revision !== expectRevision) return { kind: 'conflict', suggestedChange: p };
      const base = { ...p, revision: p.revision + 1, updatedAt: now() };
      let next: StoredSuggestedChange;
      switch (step.kind) {
        case 'candidate':
          next = { ...base, candidate: step.candidate };
          break;
        case 'evaluation': {
          const { pinChangeId: _cleared, ...rest } = base;
          next = { ...rest, evaluation: step.evaluation };
          break;
        }
        case 'pin':
          next = { ...base, pinChangeId: step.pinChangeId };
          break;
        case 'withdrawn':
          next = { ...base, withdrawn: step.withdrawn };
          break;
      }
      rows.set(suggestedChangeId as unknown as string, next);
      return { kind: 'ok', suggestedChange: next };
    },
    async queryObservations() {
      return { kind: 'ok', page: { data: [] } };
    },
  } satisfies SupervisorBinding & { rows: unknown; before: unknown };
  return store;
}
