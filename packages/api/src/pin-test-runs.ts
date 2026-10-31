// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The test runs a pin change starts (DESIGN 10.1 step 1, 10.3). A pin
 * checks the version it pins in each project whose running version it
 * changes and that has active cases: a project pin its project, a tenant
 * or org pin each such project the agent runs in, a segment pin none
 * (`projectsPinMoves`). The run the pin names (`Pin.testRunId`) is reused
 * where it can stand for the check (`isReusableTestRun`), and applies at
 * once when the pin took effect (`applyNamedTestRun`). Elsewhere a run
 * starts with correlation `pin:<changeId>`, and applies at its end
 * (`applyTestRunOutcome`). A pin that waits for approval starts its runs
 * at once, and changes nothing until the approval pins it
 * (`pinTookEffect`).
 */

import type { Logger } from '@kindgi/log';
import type { AgentId, AgentPinScope, ProjectId, RunId, Semver, TenantId } from '@kindgi/types';

import type { Pin } from './agent-pin-binding.js';
import type { ItemProjectsBinding } from './item-projects-binding.js';
import type { TestRun, TestRunBinding } from './test-run-binding.js';
import {
  type TestRunOutcome,
  type TestRunOutcomeDeps,
  applyNamedTestRun,
  isReusableTestRun,
  pinRunCorrelation,
  reapplyTestRunOutcomes,
  tookEffect,
} from './test-run-outcome.js';
import {
  type FrozenTestSet,
  type TestSetFreezeBinding,
  agentTestSetId,
} from './test-set-binding.js';
import { type WhatRuns, whatRunsByProject } from './what-runs.js';

export interface PinTestRunDeps extends Omit<TestRunOutcomeDeps, 'testRuns'> {
  readonly testRuns: Pick<TestRunBinding, 'get' | 'start' | 'list'>;
  readonly testSets: Pick<TestSetFreezeBinding, 'freezeTestSet'>;
  /** The projects an agent runs in, for a tenant or org pin. Absent: such a pin checks none. */
  readonly itemProjects?: Pick<ItemProjectsBinding, 'projectsOf'>;
}

/** A test run a pin checks a project with: the one it named, reused, or one it started. */
export interface PinTestRun {
  readonly projectId: ProjectId;
  readonly testRunId: RunId;
}

/** A pin's test runs, and the corrections a reused run changed (the pin answer, DESIGN 10.3). */
export interface PinTestRuns extends TestRunOutcome {
  readonly testRuns: readonly PinTestRun[];
}

export const NO_PIN_TEST_RUNS: PinTestRuns = { testRuns: [], fixed: [], reopened: [] };

/**
 * The projects a pin of `version` for `scope` moves to it, read before the
 * change is recorded: of the projects inside the scope (`projectsInside`),
 * each that the pin will cover, since nothing more specific than its
 * scope covers it now, and that runs another version now, or none.
 */
export async function projectsPinMoves(
  deps: Pick<PinTestRunDeps, 'agentPins' | 'projects' | 'itemProjects'>,
  q: {
    readonly tenantId: TenantId;
    readonly agentId: string;
    readonly scope: AgentPinScope;
    readonly version: Semver;
  },
): Promise<readonly ProjectId[]> {
  const { tenantId, agentId, scope } = q;
  const inside = await projectsInside(deps, tenantId, agentId, scope);
  const rows = await whatRunsByProject(deps.agentPins, { tenantId, agentId }, inside);
  return rows
    .filter((row) => covers(scope, row.runs) && row.runs?.version !== q.version)
    .map((row) => row.projectId);
}

/**
 * Check a recorded pin change in `projects` (`projectsPinMoves`, read
 * before it was recorded), each that has active cases: the run the change
 * names where it's reusable, applied at once when the change took effect;
 * else a run started with correlation `pin:<changeId>`. A refused change,
 * or one no longer waiting, starts none. The change is recorded already,
 * so a start the binding refuses, or a read that throws, leaves only its
 * project out of `testRuns` (and is logged): the pin stands, and the
 * project's statuses wait for its next check.
 */
export async function startPinTestRuns(
  deps: PinTestRunDeps,
  input: {
    readonly tenantId: TenantId;
    readonly change: Pin;
    readonly projects: readonly ProjectId[];
    readonly log?: Pick<Logger, 'warn'>;
  },
): Promise<PinTestRuns> {
  const { tenantId, change } = input;
  if (!checksNow(change)) return NO_PIN_TEST_RUNS;
  const found = collect();
  for (const projectId of input.projects) {
    await eachProject(input.log, change, projectId, async () => {
      const frozen = await activeCases(deps, tenantId, change, projectId);
      if (frozen === undefined) return;
      if (await reuseNamed(deps, tenantId, change, projectId, frozen, found)) return;
      await start(deps, tenantId, change, projectId, frozen, found);
    });
  }
  return found.answer();
}

/**
 * After an approval pins a change that waited (DESIGN 10.3): in each
 * project the change now covers that has active cases, apply the run the
 * change names where it's reusable, and the change's own finished
 * `pin:<changeId>` runs, newest first. A project with neither, nor one of
 * its runs still going, gets one started; a run still going applies at
 * its own end. Applying again changes nothing, so the start-up reconcile
 * can retry it. A project whose step throws is logged, and the others
 * still go. Answers nothing for a change that didn't take effect.
 */
export async function pinTookEffect(
  deps: PinTestRunDeps,
  input: {
    readonly tenantId: TenantId;
    readonly changeId: string;
    readonly log?: Pick<Logger, 'warn'>;
  },
): Promise<PinTestRuns> {
  const { tenantId } = input;
  const change = await deps.agentPins.changes.get(tenantId, input.changeId);
  if (change === null || change.action !== 'pin' || !tookEffect(change)) return NO_PIN_TEST_RUNS;
  const { agentId } = change;
  const inside = await projectsInside(deps, tenantId, agentId, change.scope);
  const rows = await whatRunsByProject(deps.agentPins, { tenantId, agentId }, inside);
  const found = collect();
  for (const { projectId } of rows.filter((row) => row.pin?.changeId === change.id)) {
    await eachProject(input.log, change, projectId, async () => {
      const frozen = await activeCases(deps, tenantId, change, projectId);
      if (frozen === undefined) return;
      if (await reuseNamed(deps, tenantId, change, projectId, frozen, found)) return;
      const own = await ownRuns(deps, tenantId, change, projectId);
      if (own.length === 0) {
        await start(deps, tenantId, change, projectId, frozen, found);
        return;
      }
      for (const run of own) found.run(projectId, run.testRunId);
      const ended = own.filter((run) => run.status === 'completed').map((run) => run.testRunId);
      found.add(await reapplyTestRunOutcomes(deps, { tenantId, testRunIds: ended }));
    });
  }
  return found.answer();
}

/**
 * One project's step of a recorded change's check. A throw there is
 * logged and leaves that project out, so the others still go.
 */
async function eachProject(
  log: Pick<Logger, 'warn'> | undefined,
  change: Pin,
  projectId: ProjectId,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (e) {
    log?.warn(
      `pin change ${change.id}'s test run in project ${projectId as unknown as string} didn't start or apply: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** A pin that checks its projects now: one that took effect, or one waiting for approval. */
function checksNow(change: Pin): boolean {
  return (
    change.action === 'pin' &&
    change.toVersion !== null &&
    (tookEffect(change) || change.status === 'pending-approval')
  );
}

/**
 * The projects inside a pin's scope that the agent can run in: a project
 * pin's own project; for a tenant pin each project the agent runs in
 * (`ItemProjectsBinding.projectsOf`), and for an org pin those in the
 * org; none for a segment pin (DESIGN 10.1 step 4), or without the binding.
 */
async function projectsInside(
  deps: Pick<PinTestRunDeps, 'projects' | 'itemProjects'>,
  tenantId: TenantId,
  agentId: string,
  scope: AgentPinScope,
): Promise<readonly ProjectId[]> {
  if (scope.kind === 'project') return [scope.projectId];
  if (scope.kind === 'segment' || deps.itemProjects === undefined) return [];
  const runIn =
    (await deps.itemProjects.projectsOf({ tenantId, kind: 'agent', id: agentId })) ?? [];
  if (scope.kind === 'tenant') return runIn;
  const inOrg: ProjectId[] = [];
  for (const projectId of runIn) {
    if ((await deps.projects.get(tenantId, projectId))?.orgId === scope.orgId) {
      inOrg.push(projectId);
    }
  }
  return inOrg;
}

/** How specific a pin's scope is: a more specific one covers a project over a wider one. */
const SPECIFIC: Readonly<Record<AgentPinScope['kind'], number>> = {
  tenant: 0,
  org: 1,
  project: 2,
  segment: 3,
};

/** Whether a pin for `scope` will cover a project that runs `runs` now: no pin more specific covers it. */
function covers(scope: AgentPinScope, runs: WhatRuns | null): boolean {
  return (
    runs === null ||
    runs.follows === 'latest' ||
    SPECIFIC[runs.pinnedScope.kind] <= SPECIFIC[scope.kind]
  );
}

/** The project's agent test set frozen now, when it has cases; `undefined` when it has none. */
async function activeCases(
  deps: Pick<PinTestRunDeps, 'testSets'>,
  tenantId: TenantId,
  change: Pin,
  projectId: ProjectId,
): Promise<FrozenTestSet | undefined> {
  const agentId = change.agentId as AgentId;
  const frozen = await deps.testSets.freezeTestSet({ tenantId, agentId, projectId });
  return frozen.cases.length === 0 ? undefined : frozen;
}

/**
 * The run the change names, when it can stand for the project's check
 * (`isReusableTestRun`): added to `found`, and applied when the change
 * took effect. `false` when there's none to reuse.
 */
async function reuseNamed(
  deps: PinTestRunDeps,
  tenantId: TenantId,
  change: Pin,
  projectId: ProjectId,
  frozen: FrozenTestSet,
  found: Found,
): Promise<boolean> {
  if (change.testRunId === undefined) return false;
  const run = await deps.testRuns.get({ tenantId, testRunId: change.testRunId as RunId });
  const { testSetVersion } = frozen;
  const version = change.toVersion as unknown as string;
  const q = { agentId: change.agentId, version, projectId, testSetVersion };
  if (run === null || !isReusableTestRun(run, q)) return false;
  found.run(projectId, run.testRunId);
  if (tookEffect(change)) {
    found.add(await applyNamedTestRun(deps, { tenantId, change, run, projectId, testSetVersion }));
  }
  return true;
}

/** Start the change's check of the project, on its test set as frozen now. */
async function start(
  deps: Pick<PinTestRunDeps, 'testRuns'>,
  tenantId: TenantId,
  change: Pin,
  projectId: ProjectId,
  frozen: FrozenTestSet,
  found: Found,
): Promise<void> {
  const started = await deps.testRuns.start({
    tenantId,
    projectId,
    testSetId: frozen.testSetId,
    testSetVersion: frozen.testSetVersion,
    agentRef: { agentId: change.agentId as AgentId, version: change.toVersion as Semver },
    correlationId: pinRunCorrelation(change.id),
  });
  if (started.kind === 'ok') found.run(projectId, started.testRunId);
}

const RUN_PAGE = 100;

/**
 * The change's own runs in the project, newest first: its correlation, on
 * the project's agent test set, started since the change. Leaves out one
 * that failed or was cancelled, which checked nothing.
 */
async function ownRuns(
  deps: Pick<PinTestRunDeps, 'testRuns'>,
  tenantId: TenantId,
  change: Pin,
  projectId: ProjectId,
): Promise<readonly TestRun[]> {
  const correlationId = pinRunCorrelation(change.id);
  const filter = {
    testSetId: agentTestSetId(change.agentId as AgentId, projectId),
    agentId: change.agentId as AgentId,
    from: change.createdAt,
  };
  const own: TestRun[] = [];
  let cursor: Awaited<ReturnType<TestRunBinding['list']>>['nextCursor'];
  for (;;) {
    const page = await deps.testRuns.list({
      tenantId,
      limit: RUN_PAGE,
      filter,
      ...(cursor !== undefined && { cursor }),
    });
    own.push(
      ...page.data.filter(
        (run) =>
          run.correlationId === correlationId &&
          run.projectId === projectId &&
          run.status !== 'failed' &&
          run.status !== 'cancelled',
      ),
    );
    if (page.nextCursor === undefined) return own;
    cursor = page.nextCursor;
  }
}

interface Found {
  run(projectId: ProjectId, testRunId: RunId): void;
  add(outcome: TestRunOutcome | undefined): void;
  answer(): PinTestRuns;
}

function collect(): Found {
  const testRuns: PinTestRun[] = [];
  const fixed: string[] = [];
  const reopened: string[] = [];
  return {
    run: (projectId, testRunId) => {
      testRuns.push({ projectId, testRunId });
    },
    add: (outcome) => {
      fixed.push(...(outcome?.fixed ?? []));
      reopened.push(...(outcome?.reopened ?? []));
    },
    answer: () => ({ testRuns, fixed, reopened }),
  };
}
