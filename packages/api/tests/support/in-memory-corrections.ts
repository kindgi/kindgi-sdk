// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, ProjectId } from '@kindgi/types';

import {
  type CorrectedRunCopy,
  type Correction,
  type CorrectionRecordInput,
  type CorrectionRegistryBinding,
  type CorrectionWithCopies,
  type CorrectorGroup,
  RUN_COPIES_MAX,
  type TestCase,
  type TestCaseExpect,
  type TestCaseRetired,
  expectOf,
  isReplayCopy,
  isTestCase,
} from '../../src/index.js';

/**
 * In-memory `CorrectionRegistryBinding` honouring supersede, one run copy per
 * run, a change that applies only from the status and sorting it expects, and
 * the agent's test set: its correction cases, hand cases and retirements.
 * `eraseRun` erases a run as the runtime's erasure does: its copy's words
 * are cleared, and `runCopies` leaves it out.
 */
export function inMemoryCorrections(): CorrectionRegistryBinding & {
  eraseRun(input: { tenantId: string; runId: string }): void;
} {
  const groups: CorrectorGroup[] = [];
  const corrections: Correction[] = [];
  const copies = new Map<string, CorrectedRunCopy>();
  const copyProjects = new Map<string, ProjectId>();
  const copyTenants = new Map<string, string>();
  const erasedRuns = new Set<string>();
  const handCases: { tenantId: string; agentId: string; testCase: TestCase }[] = [];
  const retirements = new Map<string, TestCaseRetired>();
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1, 0, 0, seq++)).toISOString();
  const sameScope = (a: CorrectorGroup['scope'], b: CorrectorGroup['scope']) =>
    JSON.stringify(a) === JSON.stringify(b);
  const page = <T>(rows: readonly T[], limit: number) => ({
    data: rows.slice(0, limit),
    hasMore: rows.length > limit,
  });
  const keepCopy = (
    input: Pick<CorrectionRecordInput, 'tenantId' | 'runId' | 'run' | 'projectId'>,
  ) => {
    if (copies.has(input.runId)) return;
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
    copyTenants.set(input.runId, input.tenantId as unknown as string);
  };
  const withRetirement = (testCase: TestCase): TestCase => {
    const retired = retirements.get(testCase.id);
    return retired === undefined ? testCase : { ...testCase, retired, updatedAt: retired.at };
  };
  // The agent's cases, newest added first.
  const casesOf = (tenantId: string, agentId: string): TestCase[] =>
    [
      ...corrections
        .filter(
          (j) =>
            j.tenantId === tenantId &&
            j.subject.id === agentId &&
            isTestCase(j) &&
            !isReplayCopy(copies.get(j.runId) ?? { output: null }),
        )
        .map(
          (j): TestCase => ({
            id: j.id,
            kind: 'correction',
            projectId: j.projectId,
            runId: j.runId,
            madeOn: j.subject.version,
            expect: expectOf(j) as TestCaseExpect,
            addedBy: j.madeBy,
            addedAt: j.createdAt,
            updatedAt: j.createdAt,
          }),
        ),
      ...handCases
        .filter((h) => h.tenantId === tenantId && h.agentId === agentId)
        .map((h) => h.testCase),
    ]
      .map(withRetirement)
      .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0));

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
      keepCopy(input);
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
      const { sortedTo, link, statusNote, fixedIn, ...rest } = current;
      const pick = <T>(given: T | null | undefined, was: T | undefined) =>
        given === undefined ? was : (given ?? undefined);
      const next = {
        ...rest,
        ...(input.status !== undefined && { status: input.status }),
        ...(input.sorted !== undefined && { sorted: input.sorted }),
        sortedTo: pick(input.sortedTo, sortedTo),
        link: pick(input.link, link),
        statusNote: pick(input.statusNote, statusNote),
        fixedIn: input.fixedIn === null ? undefined : fixedIn,
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
    async testSet(input) {
      const cases = casesOf(input.tenantId, input.agentId).filter(
        (k) => k.projectId === input.projectId,
      );
      const retired = cases.filter((k) => k.retired !== undefined).length;
      const newest = cases[0];
      return {
        active: cases.length - retired,
        retired,
        ...(newest !== undefined && { lastAddedAt: newest.addedAt }),
      };
    },
    async listCases(input) {
      const rows = casesOf(input.tenantId, input.agentId)
        .filter((k) => k.projectId === input.projectId)
        .filter((k) => input.kinds === undefined || input.kinds.includes(k.kind))
        .filter((k) => input.includeRetired === true || k.retired === undefined);
      const from = input.cursor === undefined ? 0 : Number(input.cursor);
      const data = rows.slice(from, from + input.limit);
      const next = from + data.length;
      return {
        data,
        hasMore: next < rows.length,
        ...(next < rows.length && { nextCursor: String(next) as Cursor }),
      };
    },
    async getCase(input) {
      return casesOf(input.tenantId, input.agentId).find((k) => k.id === input.caseId) ?? null;
    },
    async runCopies(input) {
      if (input.runIds.length > RUN_COPIES_MAX) {
        throw new RangeError(`runCopies takes at most ${RUN_COPIES_MAX} run ids`);
      }
      return input.runIds.flatMap((runId) => {
        const copy = copies.get(runId);
        return copy !== undefined &&
          !erasedRuns.has(runId) &&
          copyTenants.get(runId) === (input.tenantId as unknown as string)
          ? [copy]
          : [];
      });
    },
    eraseRun({ tenantId, runId }) {
      const copy = copies.get(runId);
      if (copy === undefined || copyTenants.get(runId) !== tenantId) return;
      const { context: _context, segments: _segments, ...kept } = copy;
      copies.set(runId, { ...kept, input: null, output: null });
      erasedRuns.add(runId);
    },
    async addCase(input) {
      keepCopy(input);
      const { tenantId, projectId, runId, run, madeBy, ...said } = input;
      const at = now();
      const testCase: TestCase = {
        id: `case-${handCases.length + 1}`,
        kind: 'hand',
        projectId,
        runId,
        madeOn: run.subject.version,
        expect: expectOf(said) as TestCaseExpect,
        addedBy: madeBy,
        addedAt: at,
        updatedAt: at,
      };
      handCases.push({ tenantId, agentId: run.subject.id, testCase });
      return testCase;
    },
    async retireCase(input) {
      const testCase = casesOf(input.tenantId, input.agentId).find((k) => k.id === input.caseId);
      if (testCase === undefined) return { kind: 'not-found' };
      if (testCase.retired !== undefined) return { kind: 'already-retired', testCase };
      retirements.set(input.caseId, { reason: input.reason, by: input.by, at: now() });
      return { kind: 'retired', testCase: withRetirement(testCase) };
    },
  };
}
