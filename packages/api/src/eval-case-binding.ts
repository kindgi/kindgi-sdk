// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, ScopeSegment, TenantId } from '@kindgi/types';

import type { CorrectedItem, CorrectedRunContext, CorrectedSubject } from './correction-binding.js';
import type { ExpectedDecisions } from './expected-decisions.js';
import type { TestCaseExpect } from './test-case-binding.js';

/**
 * Caller-plugged storage for the cases of a test-set version, kept
 * apart from the version's `spec` because a set can hold hundreds of
 * cases. A `corrections` test set version's cases are built from corrections: each
 * is a copy of one corrected run (its input, what it read, the output that
 * was corrected) with the corrections of its items summed up. Copies, so a
 * test set stays the same when corrections are removed or runs purged.
 *
 * Cases are written once, when the version is published, and removed
 * with it.
 */
export interface EvalCaseStoreBinding {
  /** Store a version's cases. Called once, right after the version is published. */
  putCases(input: EvalCasePutInput): Promise<void>;
  /** A version's cases, in the order they were stored, cursor-paginated. */
  listCases(input: EvalCaseListInput): Promise<EvalCasePage>;
}

/** The corrections of one item of a case's output, summed up. */
export interface CorrectedItemSummary extends CorrectedItem {
  readonly yes: number;
  readonly no: number;
  /** The weight behind "yes" (an unclassified correction counts 1). */
  readonly yesWeight: number;
  /** The weight behind all corrections of the item. */
  readonly totalWeight: number;
  /**
   * The same two, counting only corrections recorded while their group was
   * restricted (`Correction.expert`), for a comparison weighted
   * `experts-only`. Absent from a test set built before restrictions:
   * no expert evidence.
   */
  readonly expert?: {
    readonly yesWeight: number;
    readonly totalWeight: number;
    /** The corrections behind these two. Absent from a test set built before correction ids. */
    readonly correctionIds?: readonly string[];
  };
  /**
   * The corrections summed into the item, by id: what a comparison on this case
   * counts. Absent from a test set built before correction ids.
   */
  readonly correctionIds?: readonly string[];
  /** The reasons given, newest first. */
  readonly reasons: readonly CorrectedReason[];
}

/** One correction's reason, and whose correction it was. */
export interface CorrectedReason {
  readonly verdict: 'yes' | 'no';
  readonly reason: string;
  /** The correction's group, when it had one. */
  readonly correctorGroupId?: string;
  /** Set when the correction was recorded while its group was restricted (`Correction.expert`). */
  readonly expert?: true;
}

/** What the agent should have done, carried onto a case from one of its corrections. */
export interface TestCaseExpectedDecisions extends ExpectedDecisions {
  /** The correction it was recorded on. */
  readonly correctionId: string;
  /** The correction's group, when it had one. */
  readonly correctorGroupId?: string;
  /** Set when the correction was recorded while its group was restricted (`Correction.expert`). */
  readonly expert?: true;
}

/** One case of a `corrections` test set: a copy of a corrected run and what people said about it. */
export interface CorrectedTestCase {
  /**
   * The case's id. A frozen case of an agent's test set has its
   * correction's id, or a `case-` id when it was added by hand. A
   * `corrections` test set built before 0.4.0 used the corrected run's id.
   */
  readonly caseId: string;
  /** The run the case was copied from. */
  readonly runId: string;
  /** What ran: the agent or flow at a version (the baseline when comparing to the recording). */
  readonly subject: CorrectedSubject;
  readonly input: unknown;
  /** What the turn read besides its input; absent when it wasn't captured. */
  readonly context?: CorrectedRunContext;
  /** The output that was corrected. */
  readonly output: unknown;
  /**
   * The segment path its run was started with, coarse to fine (empty:
   * none). Set on a frozen case when its run's copy has it.
   */
  readonly segments?: readonly ScopeSegment[];
  readonly items: readonly CorrectedItemSummary[];
  /**
   * Experts' expected decisions carried onto this case, each graded on the
   * replay. Absent when none; `experts-only` keeps only the entries
   * whose correction was restricted.
   */
  readonly corrections?: readonly TestCaseExpectedDecisions[];
  /**
   * What the case expects of a run, as the agent's test set lists it: set
   * on a frozen case of an agent's test set, from its own correction or
   * hand case, which also fill `items` and `corrections`. A grader reads it
   * when it's present, and `items` and `corrections` otherwise.
   */
  readonly expect?: TestCaseExpect;
  /**
   * Set on a frozen case whose test case is an expert's
   * (`TestCase.expert`): `experts-only` grades its `expect`, and drops the
   * `expect` of every other case.
   */
  readonly expert?: true;
  /**
   * An erasure cleared this case (a person's words were erased): its
   * `input`, `output` and `context` are gone, its items empty, and its
   * corrections, `expect` and `segments` dropped. Test runs leave it out
   * and count it (`erased`).
   */
  readonly erased?: true;
}

export interface EvalCasePutInput {
  readonly tenantId: TenantId;
  readonly testSetId: string;
  readonly version: string;
  readonly cases: readonly CorrectedTestCase[];
}

export interface EvalCaseListInput {
  readonly tenantId: TenantId;
  readonly testSetId: string;
  readonly version: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface EvalCasePage {
  readonly data: readonly CorrectedTestCase[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}
