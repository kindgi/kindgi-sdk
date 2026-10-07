// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, TenantId } from '@kindgi/types';

import type { JudgedItem, JudgedRunContext, JudgedSubject } from './judgment-binding.js';

/**
 * Caller-plugged storage for the cases of an eval-suite version, kept
 * apart from the version's `spec` because a set can hold hundreds of
 * cases. A `judged` suite version's cases are built from judgments: each
 * is a copy of one judged run (its input, what it read, the output that
 * was judged) with the judgments of its items summed up. Copies, so a
 * test set stays the same when judgments are removed or runs purged.
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

/** The judgments of one item of a case's output, summed up. */
export interface JudgedItemSummary extends JudgedItem {
  readonly yes: number;
  readonly no: number;
  /** The weight behind "yes" (an unclassified judgment counts 1). */
  readonly yesWeight: number;
  /** The weight behind all judgments of the item. */
  readonly totalWeight: number;
  /**
   * The same two, counting only judgments recorded while their class was
   * restricted (`Judgment.restricted`), for a comparison weighted
   * `restricted-only`. Absent from a test set built before restrictions:
   * no restricted evidence.
   */
  readonly restricted?: { readonly yesWeight: number; readonly totalWeight: number };
  /** The reasons given, newest first. */
  readonly reasons: readonly { readonly verdict: 'yes' | 'no'; readonly reason: string }[];
}

/** One case of a `judged` suite: a copy of a judged run and what people said about it. */
export interface JudgedEvalCase {
  /** The judged run's id. */
  readonly caseId: string;
  /** What ran: the agent or flow at a version (the baseline when comparing to the recording). */
  readonly subject: JudgedSubject;
  readonly input: unknown;
  /** What the turn read besides its input; absent when it wasn't captured. */
  readonly context?: JudgedRunContext;
  /** The output that was judged. */
  readonly output: unknown;
  readonly items: readonly JudgedItemSummary[];
  /**
   * An erasure cleared this case (a person's words were erased): its
   * `input`, `output` and `context` are gone and its items empty. Eval
   * runs leave it out and count it (`erased`).
   */
  readonly erased?: true;
}

export interface EvalCasePutInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly version: string;
  readonly cases: readonly JudgedEvalCase[];
}

export interface EvalCaseListInput {
  readonly tenantId: TenantId;
  readonly suiteId: string;
  readonly version: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface EvalCasePage {
  readonly data: readonly JudgedEvalCase[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}
