// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type { FixProposalId, Timestamp } from '@kindgi/types';

import type { StoredProposal, SupervisorBinding } from '../../src/index.js';

/**
 * The proposals half of a `SupervisorBinding` in memory, keeping the
 * contract a store keeps: newest first, dedup by fingerprint among
 * proposals not withdrawn, and each recorded step a compare-and-set on
 * `revision` (an `evaluation` clears `promotionId`). `before` runs before
 * each record, so a test can slip a competing write in.
 */
export function inMemoryProposals(): SupervisorBinding & {
  readonly rows: Map<string, StoredProposal>;
  before: (() => void) | undefined;
} {
  const rows = new Map<string, StoredProposal>();
  let clock = Date.parse('2026-10-07T00:00:00.000Z');
  const now = () => {
    clock += 1000;
    return new Date(clock).toISOString() as Timestamp;
  };
  const store = {
    rows,
    before: undefined as (() => void) | undefined,
    async listProposals({ tenantId, limit, cursor, agentId, tier, liveScope }) {
      const all = [...rows.values()]
        .filter((p) => p.tenantId === tenantId)
        .filter((p) => agentId === undefined || p.agentId === agentId)
        .filter((p) => tier === undefined || p.tier === tier)
        .filter(
          (p) => liveScope === undefined || JSON.stringify(p.scope) === JSON.stringify(liveScope),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const at = cursor === undefined ? 0 : Number(cursor);
      const data = all.slice(at, at + limit);
      return at + limit < all.length ? { data, nextCursor: String(at + limit) as never } : { data };
    },
    async getProposal({ tenantId, proposalId }) {
      const p = rows.get(proposalId as unknown as string);
      return p !== undefined && p.tenantId === tenantId ? p : null;
    },
    async createProposal(input) {
      const same = [...rows.values()].find(
        (p) =>
          p.tenantId === input.tenantId &&
          p.fingerprint === input.fingerprint &&
          p.withdrawn === undefined,
      );
      if (same !== undefined) return { kind: 'dedup', proposal: same };
      const at = now();
      const proposal: StoredProposal = {
        ...input,
        id: randomUUID() as FixProposalId,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      rows.set(proposal.id as unknown as string, proposal);
      return { kind: 'ok', proposal };
    },
    async recordProposal({ tenantId, proposalId, expectRevision, step }) {
      store.before?.();
      const p = rows.get(proposalId as unknown as string);
      if (p === undefined || p.tenantId !== tenantId) return { kind: 'not-found' };
      if (p.revision !== expectRevision) return { kind: 'conflict', proposal: p };
      const base = { ...p, revision: p.revision + 1, updatedAt: now() };
      let next: StoredProposal;
      switch (step.kind) {
        case 'candidate':
          next = { ...base, candidate: step.candidate };
          break;
        case 'evaluation': {
          const { promotionId: _cleared, ...rest } = base;
          next = { ...rest, evaluation: step.evaluation };
          break;
        }
        case 'promotion':
          next = { ...base, promotionId: step.promotionId };
          break;
        case 'rolled-back':
          next = { ...base, rolledBack: step.rolledBack };
          break;
        case 'withdrawn':
          next = { ...base, withdrawn: step.withdrawn };
          break;
      }
      rows.set(proposalId as unknown as string, next);
      return { kind: 'ok', proposal: next };
    },
    async queryObservations() {
      return { kind: 'ok', page: { data: [] } };
    },
  } satisfies SupervisorBinding & { rows: unknown; before: unknown };
  return store;
}
