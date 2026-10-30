// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, ProjectId } from '@kindgi/types';

import {
  type CorrectedRunCopy,
  type CorrectedRunWithCorrections,
  type Correction,
  type CorrectionRegistryBinding,
  type CorrectionWithCopies,
  type CorrectorGroup,
  isReplayCopy,
  segmentsStartWith,
} from '../../src/index.js';

/**
 * In-memory `CorrectionRegistryBinding` honouring supersede, one run copy per
 * run, and a change that applies only from the status and sorting it expects.
 */
export function inMemoryCorrections(): CorrectionRegistryBinding {
  const groups: CorrectorGroup[] = [];
  const corrections: Correction[] = [];
  const copies = new Map<string, CorrectedRunCopy>();
  const copyProjects = new Map<string, ProjectId>();
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1, 0, 0, seq++)).toISOString();
  const sameScope = (a: CorrectorGroup['scope'], b: CorrectorGroup['scope']) =>
    JSON.stringify(a) === JSON.stringify(b);
  const page = <T>(rows: readonly T[], limit: number) => ({
    data: rows.slice(0, limit),
    hasMore: rows.length > limit,
  });

  return {
    async createGroup(input) {
      const taken = groups.some(
        (k) =>
          k.unregisteredAt === undefined &&
          k.name === input.name &&
          sameScope(k.scope, input.scope),
      );
      if (taken) return { kind: 'name-taken' };
      const at = now();
      const correctorGroup: CorrectorGroup = {
        id: `jc-${groups.length + 1}`,
        tenantId: input.tenantId,
        scope: input.scope,
        name: input.name,
        weight: input.weight,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.assertableBy !== undefined && { assertableBy: input.assertableBy }),
        createdAt: at,
        updatedAt: at,
      };
      groups.push(correctorGroup);
      return { kind: 'created', correctorGroup };
    },
    async listGroups(input) {
      const rows = groups
        .filter((k) => k.unregisteredAt === undefined)
        .filter((k) => input.scope === undefined || sameScope(k.scope, input.scope))
        .reverse();
      const from = input.cursor === undefined ? 0 : Number(input.cursor);
      const data = rows.slice(from, from + input.limit);
      const next = from + data.length;
      return {
        data,
        hasMore: next < rows.length,
        ...(next < rows.length && { nextCursor: String(next) as Cursor }),
      };
    },
    async getGroup(input) {
      const k = groups.find((c) => c.id === input.correctorGroupId) ?? null;
      if (k === null) return null;
      return k.unregisteredAt !== undefined && input.includeUnregistered !== true ? null : k;
    },
    async updateGroup(input) {
      const i = groups.findIndex(
        (c) => c.id === input.correctorGroupId && c.unregisteredAt === undefined,
      );
      const current = groups[i];
      if (current === undefined) return null;
      const { assertableBy: _was, ...rest } = current;
      const assertableBy =
        input.assertableBy === undefined ? current.assertableBy : (input.assertableBy ?? undefined);
      const next: CorrectorGroup = {
        ...rest,
        ...(input.weight !== undefined && { weight: input.weight }),
        ...(input.description !== undefined && { description: input.description }),
        ...(assertableBy !== undefined && { assertableBy }),
        updatedAt: now(),
      };
      groups[i] = next;
      return next;
    },
    async unregisterGroup(input) {
      const i = groups.findIndex(
        (c) => c.id === input.correctorGroupId && c.unregisteredAt === undefined,
      );
      const current = groups[i];
      if (current === undefined) return { unregistered: false };
      groups[i] = { ...current, unregisteredAt: now() };
      return { unregistered: true };
    },

    async record(input) {
      const id = `j-${corrections.length + 1}`;
      if (!copies.has(input.runId)) {
        copies.set(input.runId, {
          runId: input.runId,
          subject: input.run.subject,
          input: input.run.input,
          output: input.run.output,
          ...(input.run.context !== undefined && { context: input.run.context }),
          ...(input.run.segments !== undefined && { segments: input.run.segments }),
          capturedAt: now(),
        });
        copyProjects.set(input.runId, input.projectId);
      }
      for (let i = 0; i < corrections.length; i++) {
        const j = corrections[i] as Correction;
        if (
          j.unregisteredAt === undefined &&
          j.runId === input.runId &&
          j.madeBy.kind === input.madeBy.kind &&
          j.madeBy.id === input.madeBy.id &&
          j.participantId === input.participantId
        ) {
          corrections[i] = { ...j, unregisteredAt: now(), supersededBy: id };
        }
      }
      const { run: _run, ...fields } = input;
      const at = now();
      const correction: Correction = {
        id,
        ...fields,
        subject: input.run.subject,
        createdAt: at,
        updatedAt: at,
      };
      corrections.push(correction);
      return correction;
    },
    async list(input) {
      const rows = corrections
        .filter((j) => j.supersededBy === undefined)
        .filter((j) =>
          input.statuses === undefined ? j.status !== 'removed' : input.statuses.includes(j.status),
        )
        .filter(
          (j) => input.sortedTo === undefined || input.sortedTo.includes(j.sortedTo ?? 'none'),
        )
        .filter(
          (j) =>
            input.from === undefined ||
            (input.from === 'experts'
              ? j.expert === true
              : j.participantId !== undefined && j.expert !== true),
        )
        .filter(
          (j) =>
            input.madeBy === undefined ||
            (j.madeBy.kind === input.madeBy.kind && j.madeBy.id === input.madeBy.id),
        )
        .filter((j) => input.since === undefined || j.createdAt >= input.since)
        .filter((j) => input.until === undefined || j.createdAt < input.until)
        .filter((j) => input.runId === undefined || j.runId === input.runId)
        .filter(
          (j) =>
            input.agentId === undefined ||
            (j.subject.kind === 'agent' && j.subject.id === input.agentId),
        )
        .filter((j) => input.agentVersion === undefined || j.subject.version === input.agentVersion)
        .filter(
          (j) =>
            input.flowId === undefined ||
            (j.subject.kind === 'flow' && j.subject.id === input.flowId),
        )
        .filter(
          (j) =>
            input.correctorGroupId === undefined || j.correctorGroupId === input.correctorGroupId,
        )
        .filter((j) => input.participantId === undefined || j.participantId === input.participantId)
        .filter(
          (j) =>
            input.scope === undefined ||
            input.scope.kind !== 'project' ||
            j.projectId === input.scope.projectId,
        )
        .reverse();
      return page(rows, input.limit);
    },
    async listCorrectedRuns(input) {
      const rows: CorrectedRunWithCorrections[] = [...copies.values()]
        .reverse()
        .filter((run) => {
          const projectId = copyProjects.get(run.runId) as ProjectId;
          return (
            (input.projectId === undefined || projectId === input.projectId) &&
            (input.agentId === undefined ||
              (run.subject.kind === 'agent' && run.subject.id === input.agentId)) &&
            (input.agentVersion === undefined || run.subject.version === input.agentVersion) &&
            (input.flowId === undefined ||
              (run.subject.kind === 'flow' && run.subject.id === input.flowId)) &&
            (input.since === undefined || run.capturedAt >= input.since) &&
            (input.until === undefined || run.capturedAt < input.until) &&
            // A run corrected before segments were captured is in no segment.
            (input.segments === undefined ||
              (run.segments !== undefined && segmentsStartWith(run.segments, input.segments))) &&
            // A comparison's replay is never a test set's case.
            !isReplayCopy(run)
          );
        })
        .map((run) => ({
          projectId: copyProjects.get(run.runId) as ProjectId,
          run,
          // Newest first.
          corrections: corrections
            .filter((j) => j.runId === run.runId && j.unregisteredAt === undefined)
            .reverse(),
        }));
      // The cursor is an offset into the newest-first rows.
      const from = input.cursor === undefined ? 0 : Number(input.cursor);
      const data = rows.slice(from, from + input.limit);
      const next = from + data.length;
      return {
        data,
        hasMore: next < rows.length,
        ...(next < rows.length && { nextCursor: String(next) as Cursor }),
      };
    },
    async get(input): Promise<CorrectionWithCopies | null> {
      const j = corrections.find((x) => x.id === input.correctionId);
      if (j === undefined) return null;
      const run = copies.get(j.runId) as CorrectedRunCopy;
      return { ...j, run };
    },
    async unregister(input) {
      const i = corrections.findIndex(
        (x) => x.id === input.correctionId && x.unregisteredAt === undefined,
      );
      const current = corrections[i];
      if (current === undefined) return { unregistered: false };
      const at = now();
      corrections[i] = { ...current, status: 'removed', unregisteredAt: at, updatedAt: at };
      return { unregistered: true };
    },
    async update(input) {
      const i = corrections.findIndex(
        (x) =>
          x.id === input.correctionId &&
          x.tenantId === input.tenantId &&
          x.unregisteredAt === undefined,
      );
      const current = corrections[i];
      if (current === undefined) return { kind: 'not-found' };
      if (
        current.status !== input.expected.status ||
        (current.sortedTo ?? null) !== input.expected.sortedTo
      ) {
        return { kind: 'changed', correction: current };
      }
      const { sortedTo, link, statusNote, ...rest } = current;
      const pick = <T>(given: T | null | undefined, was: T | undefined) =>
        given === undefined ? was : (given ?? undefined);
      const next = {
        ...rest,
        ...(input.status !== undefined && { status: input.status }),
        ...(input.sorted !== undefined && { sorted: input.sorted }),
        sortedTo: pick(input.sortedTo, sortedTo),
        link: pick(input.link, link),
        statusNote: pick(input.statusNote, statusNote),
        updatedAt: now(),
      };
      // Absent, not `undefined`, as a store answers it.
      const correction = Object.fromEntries(
        Object.entries(next).filter(([, v]) => v !== undefined),
      ) as unknown as Correction;
      corrections[i] = correction;
      return { kind: 'updated', correction };
    },
    async counts(input) {
      const counts = { open: 0, beingFixed: 0, withOwner: 0, fixed: 0, wontFix: 0, removed: 0 };
      const key = {
        open: 'open',
        'being-fixed': 'beingFixed',
        'with-owner': 'withOwner',
        fixed: 'fixed',
        'wont-fix': 'wontFix',
        removed: 'removed',
      } as const;
      for (const j of corrections) {
        if (j.tenantId !== input.tenantId || j.supersededBy !== undefined) continue;
        if (input.scope?.kind === 'project' && j.projectId !== input.scope.projectId) continue;
        if (
          input.agentId !== undefined &&
          !(j.subject.kind === 'agent' && j.subject.id === input.agentId)
        ) {
          continue;
        }
        counts[key[j.status]] += 1;
      }
      return counts;
    },
    async correctionsByIds(input) {
      return corrections
        .filter(
          (j) =>
            j.tenantId === input.tenantId &&
            j.supersededBy === undefined &&
            input.ids.includes(j.id),
        )
        .map((j) => ({ id: j.id, status: j.status, sortedTo: j.sortedTo ?? null }));
    },
  };
}
