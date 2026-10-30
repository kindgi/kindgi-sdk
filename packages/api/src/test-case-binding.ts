// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type {
  CorrectedAnswerItem,
  Correction,
  CorrectionMadeBy,
  CorrectionRecordInput,
} from './correction-binding.js';
import type { ExpectedCall } from './expected-decisions.js';

/**
 * An agent's test set: the cases a version of it is checked on. There is
 * one per agent, computed when it's read, so nothing has to build it and
 * nothing is copied. Its cases are:
 *
 * - every correction of the agent's runs except Won't fix and Removed ones
 *   (Fixed and With the owner included: that's how "passed before, fails
 *   now" is seen), each under the correction's own id;
 * - and cases added by hand (`case-…`), which have a correction's body but
 *   no status, aren't sorted, and never count toward Improve's trigger,
 *   the expert queue's progress or a rule's yes-rate.
 *
 * A case belongs to its run's project, so a project's test set is the
 * agent's set narrowed to that project's cases. A retired case stays
 * listed, but no test run checks it; there is no un-retire, and retiring a
 * correction's case doesn't change the correction's status.
 *
 * A superseded correction, and one on a comparison's replay
 * (`isReplayCopy`), is never a case.
 */
export const TEST_CASE_KINDS = ['correction', 'hand'] as const;
export type TestCaseKind = (typeof TEST_CASE_KINDS)[number];

/** What a case expects of a run's decisions. */
export type TestCaseDecisions =
  /** It calls the same tools the corrected run called, by name, in any order. */
  | { readonly verdict: 'right' }
  /** It calls every `shouldCall` tool (with its `args` where given) and none of `mustNotCall`, checked exactly. */
  | {
      readonly verdict: 'wrong';
      readonly shouldCall?: readonly ExpectedCall[];
      readonly mustNotCall?: readonly string[];
    };

/** What a case expects of a run's answer. A judging model checks it. */
export type TestCaseAnswer =
  /** It says what the corrected run's answer said. */
  | { readonly verdict: 'right' }
  /** It does what `shouldSay` or `why` asks. */
  | { readonly verdict: 'wrong'; readonly shouldSay?: string; readonly why?: string };

/** One part for each part its correction gave a verdict on; at least one. */
export interface TestCaseExpect {
  readonly decisions?: TestCaseDecisions;
  readonly answer?: TestCaseAnswer;
  /** A ranked answer's items, scored as `weightedPrecisionAtK`. */
  readonly items?: readonly CorrectedAnswerItem[];
}

export interface TestCaseRetired {
  readonly reason: string;
  readonly by: CorrectionMadeBy;
  readonly at: string;
}

export interface TestCase {
  /** A correction's case has the correction's id; a hand case's starts `case-`. */
  readonly id: string;
  readonly kind: TestCaseKind;
  readonly projectId: ProjectId;
  readonly runId: string;
  /** The agent version the run ran. */
  readonly madeOn: string;
  readonly expect: TestCaseExpect;
  /** Who made the correction, or added the case. */
  readonly addedBy: CorrectionMadeBy;
  readonly addedAt: string;
  /** When the case last changed: its `addedAt` until it's retired or an erasure clears its words. */
  readonly updatedAt: string;
  readonly retired?: TestCaseRetired;
}

/**
 * What a correction's verdicts expect of a run, or `null` when they leave
 * nothing to check (an erasure cleared a wrong answer's words).
 */
export function expectOf(
  said: Pick<
    Correction,
    'decisions' | 'shouldCall' | 'mustNotCall' | 'answer' | 'shouldSay' | 'why' | 'items'
  >,
): TestCaseExpect | null {
  const decisions: TestCaseDecisions | undefined =
    said.decisions === 'right'
      ? { verdict: 'right' }
      : said.decisions === 'wrong' &&
          ((said.shouldCall?.length ?? 0) > 0 || (said.mustNotCall?.length ?? 0) > 0)
        ? {
            verdict: 'wrong',
            ...(said.shouldCall !== undefined && { shouldCall: said.shouldCall }),
            ...(said.mustNotCall !== undefined && { mustNotCall: said.mustNotCall }),
          }
        : undefined;
  const answer: TestCaseAnswer | undefined =
    said.answer === 'right'
      ? { verdict: 'right' }
      : said.answer === 'wrong' && (said.shouldSay !== undefined || said.why !== undefined)
        ? {
            verdict: 'wrong',
            ...(said.shouldSay !== undefined && { shouldSay: said.shouldSay }),
            ...(said.why !== undefined && { why: said.why }),
          }
        : undefined;
  const items = said.items !== undefined && said.items.length > 0 ? said.items : undefined;
  if (decisions === undefined && answer === undefined && items === undefined) return null;
  return {
    ...(decisions !== undefined && { decisions }),
    ...(answer !== undefined && { answer }),
    ...(items !== undefined && { items }),
  };
}

/** Whether a correction is a case of its agent's test set (see `TEST_CASE_KINDS`). */
export function isTestCase(correction: Correction): boolean {
  return (
    correction.subject.kind === 'agent' &&
    correction.supersededBy === undefined &&
    correction.status !== 'wont-fix' &&
    correction.status !== 'removed' &&
    expectOf(correction) !== null
  );
}

export interface TestSetOfInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly projectId: ProjectId;
}

/** How many cases a project's test set of an agent has, and when the newest was added. */
export interface TestSetCounts {
  readonly active: number;
  readonly retired: number;
  /** Absent while it has no case. */
  readonly lastAddedAt?: string;
}

export interface TestCaseListInput extends TestSetOfInput {
  /** Absent: both kinds. */
  readonly kinds?: readonly TestCaseKind[];
  /** Retired cases too. Absent: active ones only. */
  readonly includeRetired?: boolean;
  readonly cursor?: Cursor;
  readonly limit: number;
}

/** Newest added first. */
export interface TestCasePage {
  readonly data: readonly TestCase[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface TestCaseGetInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly caseId: string;
}

/**
 * A case added by hand: a correction's body on one of the agent's runs,
 * with no status or sorting. The run's copy is stored with it when the run
 * has none yet, as with a correction.
 */
export type TestCaseAddInput = Omit<
  CorrectionRecordInput,
  'status' | 'sortedTo' | 'sorted' | 'fixedIn' | 'correctorGroupId' | 'expert' | 'participantId'
>;

export interface TestCaseRetireInput extends TestCaseGetInput {
  readonly reason: string;
  readonly by: CorrectionMadeBy;
}

export type TestCaseRetireOutcome =
  | { readonly kind: 'retired'; readonly testCase: TestCase }
  | { readonly kind: 'already-retired'; readonly testCase: TestCase }
  | { readonly kind: 'not-found' };
