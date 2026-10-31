// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a test run's end does to its project's corrections, when a pin, an
 * unpin, going back or Latest moving started it: the run checked the version
 * the project started running, on the project's test set, and each
 * correction it checked becomes `fixed` or reopens (`planRunOutcome`).
 *
 * Such a run names why it started in its correlation id: `pin:<changeId>`
 * for a pin change, `latest:<agentId>:<projectId>` for Latest moving. A
 * caller can't start a run with either (`isReservedCorrelation`). An
 * outcome applies only while the project still runs the run's version, so
 * a run that a newer change overtook changes nothing. A `pin:` run applies
 * only as its change's own run (`startedThisRun`), and takes how, who and
 * when from the project's newest pin change as it applies, not from the
 * change that started it.
 */

import type { ProjectBinding } from '@kindgi/platform';
import { highestVersion } from '@kindgi/tools';
import type { AgentId, AgentPinScope, ProjectId, RunId, TenantId } from '@kindgi/types';

import type { AgentPinBindings, Pin } from './agent-pin-binding.js';
import type { CorrectedCaseResult } from './corrected-dispatcher.js';
import type {
  Correction,
  CorrectionMadeBy,
  CorrectionRegistryBinding,
  CorrectionReopenedHow,
  CorrectionStatus,
} from './correction-binding.js';
import { type RunOutcomeInput, planRunOutcome } from './correction-sorting.js';
import type { TestRun, TestRunBinding, TestRunComparison } from './test-run-binding.js';
import { agentTestSetId } from './test-set-binding.js';
import { type WhatRuns, type WhatRunsInProject, whatRunsByProject } from './what-runs.js';

const PIN = 'pin:';
const LATEST = 'latest:';

/**
 * The correlation id prefixes of the test runs Kindgi starts itself, for a
 * pin change and for Latest moving. A caller's start of a test run may not
 * use them (`POST /v1/test-sets/{testSetId}/runs` answers `bad-input`).
 */
export const RESERVED_CORRELATION_PREFIXES: readonly string[] = [PIN, LATEST];

/** Whether a correlation id starts with one of `RESERVED_CORRELATION_PREFIXES`. */
export function isReservedCorrelation(correlationId: string): boolean {
  return RESERVED_CORRELATION_PREFIXES.some((prefix) => correlationId.startsWith(prefix));
}

/** The correlation id of a test run a pin change started. */
export function pinRunCorrelation(changeId: string): string {
  return `${PIN}${changeId}`;
}

/** The correlation id of a test run Latest moving in a project started. */
export function latestRunCorrelation(agentId: string, projectId: ProjectId): string {
  return `${LATEST}${agentId}:${projectId as unknown as string}`;
}

/** Why a test run started, from its correlation id; `undefined` for any other run. */
export type TestRunReason =
  | { readonly kind: 'pin'; readonly changeId: string }
  | { readonly kind: 'latest'; readonly agentId: string; readonly projectId: ProjectId };

export function testRunReason(correlationId: string | undefined): TestRunReason | undefined {
  if (correlationId === undefined) return undefined;
  if (correlationId.startsWith(PIN)) {
    const changeId = correlationId.slice(PIN.length);
    return changeId.length === 0 ? undefined : { kind: 'pin', changeId };
  }
  if (correlationId.startsWith(LATEST)) {
    const rest = correlationId.slice(LATEST.length);
    const at = rest.lastIndexOf(':');
    if (at <= 0 || at === rest.length - 1) return undefined;
    return {
      kind: 'latest',
      agentId: rest.slice(0, at),
      projectId: rest.slice(at + 1) as ProjectId,
    };
  }
  return undefined;
}

export interface TestRunOutcomeDeps {
  readonly testRuns: Pick<TestRunBinding, 'get'>;
  readonly agentPins: Pick<AgentPinBindings, 'pinned' | 'latest' | 'changes'>;
  readonly corrections: Pick<CorrectionRegistryBinding, 'list' | 'applyRunOutcome'>;
  /** Whether an org pin's run is of a project in the org (`startedThisRun`). */
  readonly projects: Pick<ProjectBinding, 'get'>;
}

/** The corrections a test run's outcome changed. */
export interface TestRunOutcome {
  readonly fixed: readonly string[];
  readonly reopened: readonly string[];
}

/** The statuses a run's outcome can change (`planRunOutcome`): an active correction's. */
const CHANGED_BY_A_RUN: readonly CorrectionStatus[] = [
  'open',
  'being-fixed',
  'with-owner',
  'fixed',
];

const CORRECTION_PAGE = 200;

/**
 * Apply an ended test run's outcome to its project's corrections. Changes
 * nothing, and answers `undefined`, unless the run completed, a pin change
 * or Latest moving started it, it tried the version as published on its
 * cases (`endedCheck`), and the project still runs its version. Applying
 * it again changes nothing (`applyRunOutcome`'s compare-and-set).
 */
export async function applyTestRunOutcome(
  deps: TestRunOutcomeDeps,
  input: { readonly tenantId: TenantId; readonly testRunId: RunId },
): Promise<TestRunOutcome | undefined> {
  return applyOne(deps, input, new Set());
}

/**
 * Apply again the outcomes of a tenant's ended runs, `testRunIds` newest
 * first: a process that stopped between a run's end and applying it never
 * applied it. Each correction is left to the newest of them that checked it
 * in a version its project still runs, so an older run's outcome never
 * lands over a newer one's, even where the newer one changed nothing. A run
 * applied before changes nothing again. Answers what they changed.
 */
export async function reapplyTestRunOutcomes(
  deps: TestRunOutcomeDeps,
  input: { readonly tenantId: TenantId; readonly testRunIds: readonly RunId[] },
): Promise<TestRunOutcome> {
  const decided = new Set<string>();
  const fixed: string[] = [];
  const reopened: string[] = [];
  for (const testRunId of input.testRunIds) {
    const outcome = await applyOne(deps, { tenantId: input.tenantId, testRunId }, decided);
    fixed.push(...(outcome?.fixed ?? []));
    reopened.push(...(outcome?.reopened ?? []));
  }
  return { fixed, reopened };
}

/**
 * One run's outcome, leaving out the corrections in `decided`, and adding
 * to it the ones this run checked once it applies.
 */
async function applyOne(
  deps: TestRunOutcomeDeps,
  input: { readonly tenantId: TenantId; readonly testRunId: RunId },
  decided: Set<string>,
): Promise<TestRunOutcome | undefined> {
  const { tenantId } = input;
  const run = await deps.testRuns.get(input);
  const check = run === null ? undefined : endedCheck(run);
  if (run === null || check === undefined) return undefined;
  return applyCheck(deps, tenantId, run, check, decided, (now) =>
    howItMoved(deps, tenantId, check, now, run),
  );
}

/**
 * Apply the run that a pin names (`Pin.testRunId`: the body's on the agent
 * pin, the card's check on the card pin) as its change's own, in a project
 * that the change made run its version: reused, it changes the statuses
 * at pin time (DESIGN 10.1 step 1), as of when the change took effect.
 * Changes nothing, and answers `undefined`, unless the change took effect,
 * the run is reusable there at the project's current `testSetVersion`
 * (`isReusableTestRun`), the project is inside the change's scope, and it
 * still runs the version.
 */
export async function applyNamedTestRun(
  deps: Pick<TestRunOutcomeDeps, 'agentPins' | 'corrections' | 'projects'>,
  input: {
    readonly tenantId: TenantId;
    readonly change: Pin;
    readonly run: TestRun;
    readonly projectId: ProjectId;
    readonly testSetVersion: string;
  },
): Promise<TestRunOutcome | undefined> {
  const { tenantId, change, run, projectId } = input;
  const version = change.toVersion as unknown as string | null;
  if (change.action !== 'pin' || version === null || !tookEffect(change)) return undefined;
  const reusable = { agentId: change.agentId, version, projectId };
  if (!isReusableTestRun(run, { ...reusable, testSetVersion: input.testSetVersion })) {
    return undefined;
  }
  if (!(await inScope(deps.projects, tenantId, change.scope, projectId))) return undefined;
  const check: EndedCheck = {
    reason: { kind: 'pin', changeId: change.id },
    ...reusable,
    endedAt: effectiveAt(change),
  };
  return applyCheck(deps, tenantId, run, check, new Set(), (now) =>
    pinMoved(deps.agentPins, tenantId, change, check, now),
  );
}

/**
 * Whether a run can stand for a pin's check of `version` in a project, so
 * none starts (DESIGN 10.1 step 1): completed, not a dry run, a
 * `corrections` run that tried the version as published, of the agent and
 * version, in the project, on its agent test set at `testSetVersion`.
 */
export function isReusableTestRun(
  run: TestRun,
  q: {
    readonly agentId: string;
    readonly version: string;
    readonly projectId: ProjectId;
    readonly testSetVersion: string;
  },
): boolean {
  return (
    run.status === 'completed' &&
    !run.dryRun &&
    run.kind === 'corrections' &&
    (run.comparison === undefined || asPublished(run.comparison)) &&
    (run.agentRef?.agentId as unknown as string | undefined) === q.agentId &&
    (run.agentRef?.version as unknown as string | undefined) === q.version &&
    run.projectId === q.projectId &&
    run.testSetId === agentTestSetId(q.agentId as AgentId, q.projectId) &&
    run.testSetVersion === q.testSetVersion
  );
}

/**
 * Apply a completed check's outcome while its project still runs its
 * version, leaving out the corrections in `decided`, and adding to it the
 * ones the run checked once it applies. `moved` says how the project came
 * to run the version; `undefined` from it changes nothing.
 */
async function applyCheck(
  deps: Pick<TestRunOutcomeDeps, 'agentPins' | 'corrections'>,
  tenantId: TenantId,
  run: TestRun,
  check: EndedCheck,
  decided: Set<string>,
  howMoved: (
    now: WhatRunsInProject & { readonly runs: WhatRuns },
  ) => Promise<Pick<RunOutcomeInput, 'how' | 'by' | 'at'> | undefined>,
): Promise<TestRunOutcome | undefined> {
  const { agentId, version, projectId } = check;
  const [now] = await whatRunsByProject(deps.agentPins, { tenantId, agentId }, [projectId]);
  const runs = now?.runs;
  if (now === undefined || runs == null || (runs.version as unknown as string) !== version) {
    return undefined;
  }
  const moved = await howMoved({ ...now, runs });
  if (moved === undefined) return undefined;
  const passed = new Map([...passedByCorrection(run)].filter(([id]) => !decided.has(id)));
  for (const id of passed.keys()) decided.add(id);
  if (passed.size === 0) return { fixed: [], reopened: [] };
  const plan = planRunOutcome({
    version,
    ...moved,
    follows: runs.follows,
    corrections: await checkedCorrections(deps.corrections, tenantId, agentId, projectId, passed),
    passed,
  });
  if (plan.changes.length === 0) return { fixed: [], reopened: [] };
  const changed = new Set(
    await deps.corrections.applyRunOutcome({
      tenantId,
      endedAt: check.endedAt,
      changes: plan.changes,
    }),
  );
  return {
    fixed: plan.fixed.filter((id) => changed.has(id)),
    reopened: plan.reopened.filter((id) => changed.has(id)),
  };
}

/** A completed check of a version in a project, and why it started. */
interface EndedCheck {
  readonly reason: TestRunReason;
  readonly agentId: string;
  readonly version: string;
  readonly projectId: ProjectId;
  readonly endedAt: string;
}

/**
 * The check an ended run was; `undefined` for a run whose end changes no
 * corrections: one not completed, a dry run, not a `corrections` run, one
 * that didn't try the version as published (`asPublished`), one not on its
 * project's agent test set (`agentTestSetId`), or a `latest:` run whose own
 * agent or project isn't its correlation's.
 */
function endedCheck(run: TestRun): EndedCheck | undefined {
  if (run.status !== 'completed' || run.dryRun || run.kind !== 'corrections') return undefined;
  if (run.comparison !== undefined && !asPublished(run.comparison)) return undefined;
  const reason = testRunReason(run.correlationId);
  const agentId = run.agentRef?.agentId as unknown as string | undefined;
  const version = run.agentRef?.version as unknown as string | undefined;
  const { projectId } = run;
  const endedAt = run.completedAt as unknown as string | undefined;
  if (
    reason === undefined ||
    agentId === undefined ||
    version === undefined ||
    projectId === undefined ||
    endedAt === undefined
  ) {
    return undefined;
  }
  if (run.testSetId !== agentTestSetId(agentId as AgentId, projectId)) return undefined;
  if (reason.kind === 'latest' && (reason.agentId !== agentId || reason.projectId !== projectId)) {
    return undefined;
  }
  return { reason, agentId, version, projectId, endedAt };
}

/**
 * Whether a comparison tried the version as published, on all its cases,
 * scored by the run itself: not with other content (`overrides`), on a
 * `sample`, or as a rescore of another run (`rescoreOf`). A release gate
 * refuses the first two for the same reason (`gate.ts`).
 */
function asPublished(comparison: TestRunComparison): boolean {
  return (
    comparison.overrides === undefined &&
    comparison.sample === undefined &&
    comparison.rescoreOf === undefined
  );
}

/**
 * How the project came to run the checked version, as it applies: a `pin:`
 * run's from the project's newest pin change (`undefined` when the run
 * isn't its change's own, `startedThisRun`, or no change is found), a
 * `latest:` run's from Latest (`undefined` once a pin covers the project,
 * even of the same version), at the time it became Latest or, where
 * nothing records one, the run's start.
 */
async function howItMoved(
  deps: Pick<TestRunOutcomeDeps, 'agentPins' | 'projects'>,
  tenantId: TenantId,
  check: EndedCheck,
  now: WhatRunsInProject & { readonly runs: WhatRuns },
  run: TestRun,
): Promise<Pick<RunOutcomeInput, 'how' | 'by' | 'at'> | undefined> {
  const { reason } = check;
  const { runs } = now;
  if (reason.kind === 'latest') {
    if (runs.follows !== 'latest') return undefined;
    return { how: 'latest', at: runs.since ?? (run.startedAt as unknown as string) };
  }
  const started = await deps.agentPins.changes.get(tenantId, reason.changeId);
  if (started === null || !(await startedThisRun(deps.projects, tenantId, started, check, run))) {
    return undefined;
  }
  return pinMoved(deps.agentPins, tenantId, started, check, now);
}

/** How a pin change's check moved its project: from the project's newest pin change (`newestChange`). */
async function pinMoved(
  agentPins: Pick<AgentPinBindings, 'changes'>,
  tenantId: TenantId,
  started: Pin,
  check: EndedCheck,
  now: WhatRunsInProject,
): Promise<Pick<RunOutcomeInput, 'how' | 'by' | 'at'> | undefined> {
  const change = await newestChange(agentPins, {
    tenantId,
    agentId: check.agentId,
    projectId: check.projectId,
    started,
    ...(now.pin !== undefined && { covering: now.pin.changeId }),
  });
  return change === undefined
    ? undefined
    : { how: changeHow(change), by: madeBy(change), at: effectiveAt(change) };
}

/**
 * The project's newest pin change that took effect, of: the change behind
 * the pin that now covers it, the change that started the run (it brought
 * the version), and the project's own newest when that is an unpin (the
 * project then follows a wider pin, or Latest). A wider scope's unpin isn't
 * read; the change that started the run stands for it. `undefined` when
 * none of them is found.
 */
async function newestChange(
  agentPins: Pick<AgentPinBindings, 'changes'>,
  q: {
    readonly tenantId: TenantId;
    readonly agentId: string;
    readonly projectId: ProjectId;
    /** The change that started the run. */
    readonly started: Pin;
    /** The change behind the pin that covers the project, when one does. */
    readonly covering?: string;
  },
): Promise<Pin | undefined> {
  const { tenantId, started } = q;
  const [covering, own] = await Promise.all([
    q.covering === undefined ? null : agentPins.changes.get(tenantId, q.covering),
    agentPins.changes.list({
      tenantId,
      agentId: q.agentId,
      scope: { kind: 'project', projectId: q.projectId },
      limit: OWN_CHANGES,
    }),
  ]);
  const ownNewest = own.data.find(tookEffect);
  const candidates = [
    covering,
    tookEffect(started) ? started : null,
    ownNewest?.action === 'unpin' ? ownNewest : null,
  ].filter((c): c is Pin => c !== null);
  return candidates.reduce<Pin | undefined>(
    (newest, c) => (newest === undefined || effectiveAt(c) > effectiveAt(newest) ? c : newest),
    undefined,
  );
}

/**
 * Whether `change` is what started this `pin:` run, its own: Kindgi starts
 * a change's runs once it's recorded, with correlation `pin:<changeId>`,
 * for the projects inside its scope, on the version a pin makes them run
 * (an unpin's is what the project follows then, which `applyOne` checks),
 * each on its project's agent test set (`endedCheck`). The start route
 * refuses `pin:` from callers, so a run that fails any of these isn't
 * the change's.
 */
async function startedThisRun(
  projects: Pick<ProjectBinding, 'get'>,
  tenantId: TenantId,
  change: Pin,
  check: EndedCheck,
  run: TestRun,
): Promise<boolean> {
  if (run.correlationId !== pinRunCorrelation(change.id) || change.agentId !== check.agentId) {
    return false;
  }
  // Fails closed: a time that doesn't parse is NaN, never at or after another.
  if (
    !(
      Date.parse(run.startedAt as unknown as string) >=
      Date.parse(change.createdAt as unknown as string)
    )
  ) {
    return false;
  }
  if (change.action === 'pin' && (change.toVersion as unknown as string | null) !== check.version) {
    return false;
  }
  return inScope(projects, tenantId, change.scope, check.projectId);
}

/** Whether `projectId` is inside `scope`. A segment pin starts no run (DESIGN 10.1 step 4). */
export async function inScope(
  projects: Pick<ProjectBinding, 'get'>,
  tenantId: TenantId,
  scope: AgentPinScope,
  projectId: ProjectId,
): Promise<boolean> {
  switch (scope.kind) {
    case 'tenant':
      return true;
    case 'org':
      return (await projects.get(tenantId, projectId))?.orgId === scope.orgId;
    case 'project':
      return scope.projectId === projectId;
    case 'segment':
      return false;
  }
}

/** How many of the project's own pin changes are read for its newest unpin. */
const OWN_CHANGES = 20;

/** An unpin, or a pin that was pinned: not one refused or still waiting. */
export function tookEffect(change: Pin): boolean {
  return change.action === 'unpin' || change.status === undefined || change.status === 'pinned';
}

/**
 * How a pin change moved the project: an unpin; going back, a pin of an
 * earlier version than what ran in the scope just before it (`ranBefore`,
 * from a pin or from Latest; on a pin recorded before that was kept, the
 * scope's own pin before); or a pin.
 */
function changeHow(change: Pin): CorrectionReopenedHow {
  if (change.action === 'unpin') return 'unpin';
  const before = (change.ranBefore ?? change.fromVersion) as unknown as string | null | undefined;
  const to = change.toVersion as unknown as string | null;
  return before != null && to !== null && isEarlier(to, before) ? 'went-back' : 'pin';
}

/** Whether `a` is an earlier version than `b`, by the one version rule (`@kindgi/tools`). */
function isEarlier(a: string, b: string): boolean {
  return a !== b && highestVersion([a, b]) === b;
}

function madeBy(change: Pin): CorrectionMadeBy {
  return { kind: change.requestedBy.kind, id: change.requestedBy.id };
}

/** When a change took effect: an approved pin when it was approved, any other when it was made. */
function effectiveAt(change: Pin): string {
  return (change.resolvedAt ?? change.createdAt) as unknown as string;
}

/**
 * Whether the run passed each correction it graded: every case that
 * carries it passed it.
 */
function passedByCorrection(run: TestRun): ReadonlyMap<string, boolean> {
  const passed = new Map<string, boolean>();
  const perCase = run.result?.perCase;
  if (!Array.isArray(perCase)) return passed;
  for (const result of perCase as readonly CorrectedCaseResult[]) {
    for (const c of result.corrections ?? []) {
      passed.set(c.correctionId, (passed.get(c.correctionId) ?? true) && c.pass);
    }
  }
  return passed;
}

/** The project's active corrections of the agent that the run graded, as they are now. */
async function checkedCorrections(
  corrections: Pick<CorrectionRegistryBinding, 'list'>,
  tenantId: TenantId,
  agentId: string,
  projectId: ProjectId,
  passed: ReadonlyMap<string, boolean>,
): Promise<readonly Correction[]> {
  const found: Correction[] = [];
  let cursor: Awaited<ReturnType<CorrectionRegistryBinding['list']>>['nextCursor'];
  for (;;) {
    const page = await corrections.list({
      tenantId,
      scope: { kind: 'project', projectId },
      agentId,
      statuses: CHANGED_BY_A_RUN,
      limit: CORRECTION_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    found.push(...page.data.filter((c) => passed.has(c.id)));
    if (!page.hasMore || page.nextCursor === undefined) return found;
    cursor = page.nextCursor;
  }
}
