// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { tuplesForCreate } from '@kindgi/authz';
import type { AgentId, Cursor, ProjectId, TenantId } from '@kindgi/types';

import {
  type CorrectedRunCopy,
  type CorrectionRegistryBinding,
  RUN_COPIES_MAX,
} from './correction-binding.js';
import type {
  CorrectedItemSummary,
  CorrectedTestCase,
  FrozenCaseStoreBinding,
} from './frozen-case-binding.js';
import type { TestCase } from './test-case-binding.js';
import {
  type FreezeTestSetInput,
  type FrozenTestSet,
  type TestSetFreezeBinding,
  type TestSetRecord,
  type TestSetRegistryBinding,
  agentTestSetId,
} from './test-set-binding.js';

export interface CreateTestSetFreezeOptions {
  /** The agent's test set: its cases (`listCases`) and their runs' copies (`runCopies`). */
  readonly corrections: CorrectionRegistryBinding;
  /** Where the frozen versions are published. */
  readonly testSets: TestSetRegistryBinding;
  /** Where a frozen version's cases are stored. */
  readonly cases: FrozenCaseStoreBinding;
}

/**
 * Freezes a project's test set of an agent, over the bindings, for a
 * check or a test run. The test set is `agentTestSetId(agentId,
 * projectId)`, of kind `corrections`, and its versions are `1.0.<n>`.
 *
 * - Its cases are the project's active cases of the agent's test set,
 *   oldest added first: each a copy of its run, with what it expects
 *   (`expect`, and the same in `items` and `corrections` for a grader that
 *   reads those). A case whose run's copy is gone, or whose run was
 *   erased, is frozen `erased`, with no words: test runs leave it out and
 *   count it.
 * - A new version is made only when the cases changed since the newest: a
 *   hash of their ids and `updatedAt` decides, kept in the version's
 *   `spec`. Else the newest is answered again.
 * - It writes nothing into a test set whose newest version isn't this
 *   agent's in this project (its `spec` names both): it throws.
 * - Reading a version needs read on its project: it's published with the
 *   project as its parent, and no owner.
 */
export function createTestSetFreeze(options: CreateTestSetFreezeOptions): TestSetFreezeBinding {
  const { corrections, testSets, cases } = options;

  return {
    async freezeTestSet(input: FreezeTestSetInput): Promise<FrozenTestSet> {
      const { tenantId, agentId, projectId } = input;
      const testSetId = agentTestSetId(agentId, projectId);
      const live = await activeCases(corrections, input);
      const fingerprint = fingerprintOf(live);

      const newest = await newestVersion(testSets, tenantId, testSetId);
      if (newest !== null && (await answersAgain(newest, input, fingerprint, cases, live))) {
        return frozen(testSetId, newest.version, live);
      }

      const copies = await runCopiesOf(corrections, tenantId, live);
      const testSet = (version: string) => ({
        id: testSetId,
        tenantId,
        version,
        kind: 'corrections' as const,
        description: `The test set of agent ${agentId as unknown as string} in project ${projectId as unknown as string}.`,
        spec: { agentId, projectId, fingerprint },
      });
      const publish = (version: string) =>
        testSets.publish({
          tenantId,
          projectId,
          testSet: testSet(version),
          enqueueTuples: (id) => tuplesForCreate({ kind: 'test_set', id, tenantId, projectId }),
        });

      let version = nextVersion(newest);
      let outcome = await publish(version);
      if (outcome.kind === 'already-registered') {
        // An unregistered version holds the number, or another freeze took it.
        const again = await newestVersion(testSets, tenantId, testSetId);
        if (again !== null && (await answersAgain(again, input, fingerprint, cases, live))) {
          return frozen(testSetId, again.version, live);
        }
        version = nextVersion(await highestVersion(testSets, tenantId, testSetId));
        outcome = await publish(version);
      }
      if (outcome.kind !== 'ok') {
        throw new Error(
          `Freezing ${testSetId}: publishing version ${version} failed (${outcome.kind})`,
        );
      }

      await cases.putCases({
        tenantId,
        testSetId,
        version,
        cases: live.map((c) => frozenCase(c, agentId, copies.get(c.runId))),
      });
      return frozen(testSetId, version, live);
    },
  };
}

/** Every active case of the project's test set (both kinds), oldest added first. */
async function activeCases(
  corrections: CorrectionRegistryBinding,
  input: FreezeTestSetInput,
): Promise<TestCase[]> {
  const out: TestCase[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await corrections.listCases({
      tenantId: input.tenantId,
      agentId: input.agentId as unknown as string,
      projectId: input.projectId,
      limit: RUN_COPIES_MAX,
      ...(cursor !== undefined && { cursor }),
    });
    out.push(...page.data);
    if (!page.hasMore || page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return out.reverse();
}

/** The hash of the cases' ids and `updatedAt`: what a new version is made for. */
function fingerprintOf(live: readonly TestCase[]): string {
  const lines = live.map((c) => `${c.id}\n${c.updatedAt}`).sort();
  return `sha256:${createHash('sha256').update(lines.join('\n\n'), 'utf8').digest('hex')}`;
}

async function newestVersion(
  testSets: TestSetRegistryBinding,
  tenantId: TenantId,
  testSetId: string,
): Promise<TestSetRecord | null> {
  const newest = await testSets.get({ tenantId, testSetId });
  if (newest !== null) return newest;
  // Every version unregistered: the newest of them still says whose it is.
  return highestVersion(testSets, tenantId, testSetId);
}

/** The highest `1.0.<n>` of the test set, unregistered ones included. */
async function highestVersion(
  testSets: TestSetRegistryBinding,
  tenantId: TenantId,
  testSetId: string,
): Promise<TestSetRecord | null> {
  let highest: TestSetRecord | null = null;
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await testSets.listVersions({
      tenantId,
      testSetId,
      limit: 100,
      includeTombstoned: true,
      ...(cursor !== undefined && { cursor }),
    });
    for (const record of page.data) {
      if (highest === null || patchOf(record.version) > patchOf(highest.version)) highest = record;
    }
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return highest;
}

/** The `<n>` of `1.0.<n>`; `-1` for any other version, so it never decides the next. */
function patchOf(version: string): number {
  const m = /^1\.0\.(0|[1-9]\d*)$/.exec(version);
  return m === null ? -1 : Number(m[1]);
}

function nextVersion(newest: TestSetRecord | null): string {
  return `1.0.${newest === null ? 0 : Math.max(patchOf(newest.version), -1) + 1}`;
}

/**
 * Only an agent's own test set is frozen into: one whose versions were
 * published by a freeze, with the agent and project in their `spec`.
 */
function assertAgentsOwn(record: TestSetRecord, agentId: AgentId, projectId: ProjectId): void {
  const { spec } = record;
  if (spec.agentId !== agentId || spec.projectId !== projectId) {
    throw new Error(
      `Test set ${record.id} isn't agent ${agentId as unknown as string}'s test set in project ${projectId as unknown as string}: its version ${record.version} doesn't name them. Nothing was frozen.`,
    );
  }
}

/**
 * Whether the test set's newest version is answered again: it was made for
 * these cases, and has them. It throws when the version isn't this agent's
 * in this project.
 */
async function answersAgain(
  newest: TestSetRecord,
  input: FreezeTestSetInput,
  fingerprint: string,
  cases: FrozenCaseStoreBinding,
  live: readonly TestCase[],
): Promise<boolean> {
  assertAgentsOwn(newest, input.agentId, input.projectId);
  return newest.spec.fingerprint === fingerprint && (await hasCases(cases, newest, live));
}

/** A version made for these cases has them, unless storing them failed after it was published. */
async function hasCases(
  cases: FrozenCaseStoreBinding,
  record: TestSetRecord,
  live: readonly TestCase[],
): Promise<boolean> {
  if (live.length === 0) return true;
  const page = await cases.listCases({
    tenantId: record.tenantId,
    testSetId: record.id,
    version: record.version,
    limit: 1,
  });
  return page.data.length > 0;
}

/** Each case's run copy, by run id, asked `RUN_COPIES_MAX` at a time. */
async function runCopiesOf(
  corrections: CorrectionRegistryBinding,
  tenantId: TenantId,
  live: readonly TestCase[],
): Promise<Map<string, CorrectedRunCopy>> {
  const runIds = [...new Set(live.map((c) => c.runId))];
  const out = new Map<string, CorrectedRunCopy>();
  for (let start = 0; start < runIds.length; start += RUN_COPIES_MAX) {
    const copies = await corrections.runCopies({
      tenantId,
      runIds: runIds.slice(start, start + RUN_COPIES_MAX),
    });
    for (const copy of copies) out.set(copy.runId, copy);
  }
  return out;
}

/** A case as frozen: its run's copy and what it expects, with the run it came from. */
function frozenCase(
  testCase: TestCase,
  agentId: AgentId,
  run: CorrectedRunCopy | undefined,
): CorrectedTestCase {
  if (run === undefined) {
    return {
      caseId: testCase.id,
      subject: { kind: 'agent', id: agentId as unknown as string, version: testCase.madeOn },
      input: null,
      output: null,
      items: [],
      erased: true,
      runId: testCase.runId,
    };
  }
  const { expect } = testCase;
  const decisions = expect.decisions;
  const correction: Pick<CorrectedTestCase, 'corrections'> =
    decisions?.verdict === 'wrong'
      ? {
          corrections: [
            {
              correctionId: testCase.id,
              calls: decisions.shouldCall ?? [],
              notCalled: decisions.mustNotCall ?? [],
            },
          ],
        }
      : {};
  return {
    caseId: testCase.id,
    subject: run.subject,
    input: run.input,
    ...(run.context !== undefined && { context: run.context }),
    output: run.output,
    ...(run.segments !== undefined && { segments: run.segments }),
    items: (expect.items ?? []).map(
      (item): CorrectedItemSummary => ({
        key: item.key,
        ...(item.pointer !== undefined && { pointer: item.pointer }),
        ...(item.rank !== undefined && { rank: item.rank }),
        yes: item.verdict === 'right' ? 1 : 0,
        no: item.verdict === 'wrong' ? 1 : 0,
        yesWeight: item.verdict === 'right' ? 1 : 0,
        totalWeight: 1,
        correctionIds: [testCase.id],
        reasons: [],
      }),
    ),
    ...correction,
    expect,
    runId: testCase.runId,
  };
}

function frozen(testSetId: string, version: string, live: readonly TestCase[]): FrozenTestSet {
  return {
    testSetId,
    testSetVersion: version,
    cases: live.map((c) => ({
      caseId: c.id,
      correctionId: c.kind === 'correction' ? c.id : null,
    })),
  };
}
