// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, ProjectId } from '@kindgi/types';

import type {
  JudgeClass,
  JudgedRunCopy,
  JudgedRunWithJudgments,
  Judgment,
  JudgmentRegistryBinding,
  JudgmentWithCopies,
} from '../../src/index.js';

/** In-memory `JudgmentRegistryBinding` honouring supersede and one run copy per run. */
export function inMemoryJudgments(): JudgmentRegistryBinding {
  const classes: JudgeClass[] = [];
  const judgments: Judgment[] = [];
  const copies = new Map<string, JudgedRunCopy>();
  const copyProjects = new Map<string, ProjectId>();
  const itemValues = new Map<string, unknown>();
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1, 0, 0, seq++)).toISOString();
  const sameScope = (a: JudgeClass['scope'], b: JudgeClass['scope']) =>
    JSON.stringify(a) === JSON.stringify(b);
  const page = <T>(rows: readonly T[], limit: number) => ({
    data: rows.slice(0, limit),
    hasMore: rows.length > limit,
  });

  return {
    async createClass(input) {
      const taken = classes.some(
        (k) =>
          k.unregisteredAt === undefined &&
          k.name === input.name &&
          sameScope(k.scope, input.scope),
      );
      if (taken) return { kind: 'name-taken' };
      const at = now();
      const judgeClass: JudgeClass = {
        id: `jc-${classes.length + 1}`,
        tenantId: input.tenantId,
        scope: input.scope,
        name: input.name,
        weight: input.weight,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.assertableBy !== undefined && { assertableBy: input.assertableBy }),
        createdAt: at,
        updatedAt: at,
      };
      classes.push(judgeClass);
      return { kind: 'created', judgeClass };
    },
    async listClasses(input) {
      const rows = classes
        .filter((k) => k.unregisteredAt === undefined)
        .filter((k) => input.scope === undefined || sameScope(k.scope, input.scope))
        .reverse();
      return page(rows, input.limit);
    },
    async getClass(input) {
      const k = classes.find((c) => c.id === input.judgeClassId) ?? null;
      if (k === null) return null;
      return k.unregisteredAt !== undefined && input.includeUnregistered !== true ? null : k;
    },
    async updateClass(input) {
      const i = classes.findIndex(
        (c) => c.id === input.judgeClassId && c.unregisteredAt === undefined,
      );
      const current = classes[i];
      if (current === undefined) return null;
      const { assertableBy: _was, ...rest } = current;
      const assertableBy =
        input.assertableBy === undefined ? current.assertableBy : (input.assertableBy ?? undefined);
      const next: JudgeClass = {
        ...rest,
        ...(input.weight !== undefined && { weight: input.weight }),
        ...(input.description !== undefined && { description: input.description }),
        ...(assertableBy !== undefined && { assertableBy }),
        updatedAt: now(),
      };
      classes[i] = next;
      return next;
    },
    async unregisterClass(input) {
      const i = classes.findIndex(
        (c) => c.id === input.judgeClassId && c.unregisteredAt === undefined,
      );
      const current = classes[i];
      if (current === undefined) return { unregistered: false };
      classes[i] = { ...current, unregisteredAt: now() };
      return { unregistered: true };
    },

    async record(input) {
      const id = `j-${judgments.length + 1}`;
      if (!copies.has(input.runId)) {
        copies.set(input.runId, {
          runId: input.runId,
          subject: input.run.subject,
          input: input.run.input,
          output: input.run.output,
          ...(input.run.context !== undefined && { context: input.run.context }),
          capturedAt: now(),
        });
        copyProjects.set(input.runId, input.projectId);
      }
      for (let i = 0; i < judgments.length; i++) {
        const j = judgments[i] as Judgment;
        if (
          j.unregisteredAt === undefined &&
          j.runId === input.runId &&
          j.item.key === input.item.key &&
          j.assertedBy.kind === input.assertedBy.kind &&
          j.assertedBy.id === input.assertedBy.id &&
          j.participantId === input.participantId
        ) {
          judgments[i] = { ...j, unregisteredAt: now(), supersededBy: id };
        }
      }
      const judgment: Judgment = {
        id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        runId: input.runId,
        subject: input.run.subject,
        item: input.item,
        verdict: input.verdict,
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.judgeClassId !== undefined && { judgeClassId: input.judgeClassId }),
        ...(input.restricted === true && { restricted: true }),
        assertedBy: input.assertedBy,
        ...(input.participantId !== undefined && { participantId: input.participantId }),
        createdAt: now(),
      };
      judgments.push(judgment);
      if (input.itemValue !== undefined) itemValues.set(id, input.itemValue);
      return judgment;
    },
    async list(input) {
      const rows = judgments
        .filter((j) => j.unregisteredAt === undefined)
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
        .filter((j) => input.verdict === undefined || j.verdict === input.verdict)
        .filter((j) => input.judgeClassId === undefined || j.judgeClassId === input.judgeClassId)
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
    async listJudgedRuns(input) {
      const rows: JudgedRunWithJudgments[] = [...copies.values()]
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
            (input.until === undefined || run.capturedAt < input.until)
          );
        })
        .map((run) => ({
          projectId: copyProjects.get(run.runId) as ProjectId,
          run,
          // Newest first.
          judgments: judgments
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
    async get(input): Promise<JudgmentWithCopies | null> {
      const j = judgments.find((x) => x.id === input.judgmentId);
      if (j === undefined) return null;
      const run = copies.get(j.runId) as JudgedRunCopy;
      return {
        ...j,
        run,
        ...(itemValues.has(j.id) && { itemValue: itemValues.get(j.id) }),
      };
    },
    async unregister(input) {
      const i = judgments.findIndex(
        (x) => x.id === input.judgmentId && x.unregisteredAt === undefined,
      );
      const current = judgments[i];
      if (current === undefined) return { unregistered: false };
      judgments[i] = { ...current, unregisteredAt: now() };
      return { unregistered: true };
    },
  };
}
