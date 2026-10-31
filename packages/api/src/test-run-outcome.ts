// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a test run's end does to its project's corrections, when a pin, an
 * unpin, going back or Latest moving started it: the run checked the version
 * the project started running, on the project's test set, and each
 * correction it checked becomes `fixed` or reopens (`planRunOutcome`).
 *
 * Such a run names why it started in its correlation id: `pin:<changeId>`
 * for a pin change, `latest:<agentId>:<projectId>` for Latest moving. An
 * outcome applies only while the project still runs the run's version, so
 * a run that a newer change overtook changes nothing. A `pin:` run takes
 * how, who and when from the project's newest pin change as it applies,
 * not from the change that started it.
 */

import type { ProjectId, RunId, TenantId } from '@kindgi/types';

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
import type { TestRun, TestRunBinding } from './test-run-binding.js';
import { type WhatRuns, type WhatRunsInProject, whatRunsByProject } from './what-runs.js';

/** The correlation id of a test run a pin change started. */
export function pinRunCorrelation(changeId: string): string {
  return `pin:${changeId}`;
}

/** The correlation id of a test run Latest moving in a project started. */
export function latestRunCorrelation(agentId: string, projectId: ProjectId): string {
  return `latest:${agentId}:${projectId as unknown as string}`;
}

/** Why a test run started, from its correlation id; `undefined` for any other run. */
export type TestRunReason =
  | { readonly kind: 'pin'; readonly changeId: string }
  | { readonly kind: 'latest'; readonly agentId: string; readonly projectId: ProjectId };

export function testRunReason(correlationId: string | undefined): TestRunReason | undefined {
  if (correlationId === undefined) return undefined;
  if (correlationId.startsWith('pin:')) {
    const changeId = correlationId.slice('pin:'.length);
    return changeId.length === 0 ? undefined : { kind: 'pin', changeId };
  }
  if (correlationId.startsWith('latest:')) {
    const rest = correlationId.slice('latest:'.length);
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
 * or Latest moving started it, and the project still runs its version.
 * Applying it again changes nothing (`applyRunOutcome`'s compare-and-set).
 */
export async function applyTestRunOutcome(
  deps: TestRunOutcomeDeps,
  input: { readonly tenantId: TenantId; readonly testRunId: RunId },
): Promise<TestRunOutcome | undefined> {
  const { tenantId } = input;
  const run = await deps.testRuns.get(input);
  const check = run === null ? undefined : endedCheck(run);
  if (run === null || check === undefined) return undefined;
  const { agentId, version, projectId } = check;
  const [now] = await whatRunsByProject(deps.agentPins, { tenantId, agentId }, [projectId]);
  const runs = now?.runs;
  if (now === undefined || runs == null || (runs.version as unknown as string) !== version) {
    return undefined;
  }
  const moved = await howItMoved(deps.agentPins, tenantId, check, { ...now, runs }, run);
  if (moved === undefined) return undefined;
  const passed = passedByCorrection(run);
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

/** The check an ended run was; `undefined` for a run whose end changes no corrections. */
function endedCheck(run: TestRun): EndedCheck | undefined {
  if (run.status !== 'completed' || run.kind !== 'corrections') return undefined;
  const reason = testRunReason(run.correlationId);
  const agentId = run.agentRef?.agentId as unknown as string | undefined;
  const version = run.agentRef?.version as unknown as string | undefined;
  const projectId = reason?.kind === 'latest' ? reason.projectId : run.projectId;
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
  return { reason, agentId, version, projectId, endedAt };
}

/**
 * How the project came to run the checked version, as it applies: a `pin:`
 * run's from the project's newest pin change (`undefined` when none is
 * found), a `latest:` run's from Latest.
 */
async function howItMoved(
  agentPins: Pick<AgentPinBindings, 'changes'>,
  tenantId: TenantId,
  check: EndedCheck,
  now: WhatRunsInProject & { readonly runs: WhatRuns },
  run: TestRun,
): Promise<Pick<RunOutcomeInput, 'how' | 'by' | 'at'> | undefined> {
  const { reason } = check;
  const { runs } = now;
  if (reason.kind === 'latest') {
    const since = runs.follows === 'latest' ? runs.since : undefined;
    return { how: 'latest', at: since ?? (run.startedAt as unknown as string) };
  }
  const change = await newestChange(agentPins, {
    tenantId,
    agentId: check.agentId,
    projectId: check.projectId,
    startedBy: reason.changeId,
    ...(now.pin !== undefined && { covering: now.pin.changeId }),
  });
  return change === undefined
    ? undefined
    : { how: changeHow(change), by: madeBy(change), at: effectiveAt(change) };
}

/**
 * The project's newest pin change that took effect: the change behind the
 * pin that now covers it, or an unpin made after it (the project then
 * follows a wider pin, or Latest): the one that started the run, or the
 * project's own newest. `undefined` when neither is found.
 */
async function newestChange(
  agentPins: Pick<AgentPinBindings, 'changes'>,
  q: {
    readonly tenantId: TenantId;
    readonly agentId: string;
    readonly projectId: ProjectId;
    readonly startedBy: string;
    /** The change behind the pin that covers the project, when one does. */
    readonly covering?: string;
  },
): Promise<Pin | undefined> {
  const { tenantId } = q;
  const [started, covering, own] = await Promise.all([
    agentPins.changes.get(tenantId, q.startedBy),
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
    started?.action === 'unpin' ? started : null,
    ownNewest?.action === 'unpin' ? ownNewest : null,
  ].filter((c): c is Pin => c !== null);
  return candidates.reduce<Pin | undefined>(
    (newest, c) => (newest === undefined || effectiveAt(c) > effectiveAt(newest) ? c : newest),
    undefined,
  );
}

/** How many of the project's own pin changes are read for its newest unpin. */
const OWN_CHANGES = 20;

/** An unpin, or a pin that was pinned: not one refused or still waiting. */
function tookEffect(change: Pin): boolean {
  return change.action === 'unpin' || change.status === undefined || change.status === 'pinned';
}

/**
 * How a pin change moved the project: an unpin, a pin of an earlier
 * version than the scope's own pin before (going back), or a pin.
 */
function changeHow(change: Pin): CorrectionReopenedHow {
  if (change.action === 'unpin') return 'unpin';
  const from = change.fromVersion as unknown as string | null;
  const to = change.toVersion as unknown as string | null;
  return from !== null && to !== null && compareVersions(to, from) < 0 ? 'went-back' : 'pin';
}

function madeBy(change: Pin): CorrectionMadeBy {
  return { kind: change.requestedBy.kind, id: change.requestedBy.id };
}

/** When a change took effect: an approved pin when it was approved, any other when it was made. */
function effectiveAt(change: Pin): string {
  return (change.resolvedAt ?? change.createdAt) as unknown as string;
}

/**
 * Semver order on `major.minor.patch[-pre]`: negative when `a` is earlier.
 * A pre-release is earlier than its release (semver.org 11).
 */
function compareVersions(a: string, b: string): number {
  const [aBase = '', aPre] = a.split('-', 2);
  const [bBase = '', bPre] = b.split('-', 2);
  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === undefined || bPre === undefined) {
    return aPre === bPre ? 0 : aPre === undefined ? 1 : -1;
  }
  return aPre.localeCompare(bPre);
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
