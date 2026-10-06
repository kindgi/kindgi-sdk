// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, ListScope, ProjectId, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for judgments: a person says yes or no, with an
 * optional reason, about one item of a run's output. A judgment may name a
 * **judge class** ("expert", "user", …: the deployment's own names) that
 * carries a weight, so later metrics can weigh judgments. Classes are
 * optional: an unclassified judgment counts with weight 1, so judging
 * needs no setup.
 *
 * A judgment keeps **copies** of what was judged: the run's input and
 * output (once per run) and the judged item. The copies outlive the run's
 * own retention, so a set of judged cases stays stable when the run is
 * purged.
 *
 * Who judged: `assertedBy` is the authenticated caller (a user, or a
 * service token such as an app's API key). It is never taken from the
 * request body. When an app judges on behalf of one of its own users, it
 * passes that user's opaque id as `participantId`.
 *
 * One live judgment per (run, item key, asserting principal, participant):
 * recording another supersedes the previous one, which stays as history.
 *
 * Every method is tenant-scoped. Deletes are soft (`unregister`); purging
 * follows the retention policies for the `judgment` and `judge_class`
 * domains.
 */
export interface JudgmentRegistryBinding {
  /** Create a judge class. `name-taken` when a live class of that scope has the name. */
  createClass(input: JudgeClassCreateInput): Promise<JudgeClassCreateOutcome>;
  /** Live classes, newest first, cursor-paginated; `scope` narrows to one scope. */
  listClasses(input: JudgeClassListInput): Promise<JudgeClassPage>;
  /**
   * One class, or `null` when unknown. `includeUnregistered` also returns
   * a retired class (judgments keep naming theirs).
   */
  getClass(input: JudgeClassGetInput): Promise<JudgeClass | null>;
  /** Change a live class's weight or description; `null` when unknown or retired. */
  updateClass(input: JudgeClassUpdateInput): Promise<JudgeClass | null>;
  /** Retire a class: no new judgments may name it. `false` when unknown or already retired. */
  unregisterClass(input: JudgeClassGetInput): Promise<{ readonly unregistered: boolean }>;

  /**
   * Record a judgment. The first judgment of a run also stores the run's
   * copy (`run`); later ones keep the stored copy. Supersedes the live
   * judgment with the same run, item key, `assertedBy` and `participantId`.
   */
  record(input: JudgmentRecordInput): Promise<Judgment>;
  /** Live judgments, newest first, cursor-paginated. */
  list(input: JudgmentListInput): Promise<JudgmentPage>;
  /** One judgment (live or not) with its copies, or `null` when unknown. */
  get(input: JudgmentGetInput): Promise<JudgmentWithCopies | null>;
  /** Soft-delete a live judgment. `false` when unknown or already removed. */
  unregister(input: JudgmentGetInput): Promise<{ readonly unregistered: boolean }>;
  /**
   * Judged runs with their copies and live judgments, newest first:
   * what a test set is built from. Optional (a binding without it can't
   * build test sets from judgments).
   */
  listJudgedRuns?(input: JudgedRunListInput): Promise<JudgedRunPage>;
}

// ---------- judge classes ----------

/**
 * Where a class applies: the whole tenant, one project, or one agent in a
 * project. A judgment may name a class whose scope covers its run.
 */
export type JudgeClassScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'project'; readonly projectId: ProjectId }
  | { readonly kind: 'agent'; readonly projectId: ProjectId; readonly agentId: string };

export const JUDGE_CLASS_SCOPE_KINDS = ['tenant', 'project', 'agent'] as const;
export type JudgeClassScopeKind = (typeof JUDGE_CLASS_SCOPE_KINDS)[number];

export interface JudgeClass {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly scope: JudgeClassScope;
  /** The deployment's own word for the class: "expert", "user", "arbitrator"… */
  readonly name: string;
  /** How much a judgment of this class counts (≥ 0); an unclassified judgment counts 1. */
  readonly weight: number;
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the class was retired. */
  readonly unregisteredAt?: string;
}

export interface JudgeClassCreateInput {
  readonly tenantId: TenantId;
  readonly scope: JudgeClassScope;
  readonly name: string;
  readonly weight: number;
  readonly description?: string;
}

export type JudgeClassCreateOutcome =
  | { readonly kind: 'created'; readonly judgeClass: JudgeClass }
  | { readonly kind: 'name-taken' };

export interface JudgeClassListInput {
  readonly tenantId: TenantId;
  readonly scope?: JudgeClassScope;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface JudgeClassPage {
  readonly data: readonly JudgeClass[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface JudgeClassGetInput {
  readonly tenantId: TenantId;
  readonly judgeClassId: string;
  readonly includeUnregistered?: boolean;
}

export interface JudgeClassUpdateInput {
  readonly tenantId: TenantId;
  readonly judgeClassId: string;
  readonly weight?: number;
  readonly description?: string;
}

/** Whether a class's scope covers a run in `projectId` whose subject is `subject`. */
export function judgeClassApplies(
  scope: JudgeClassScope,
  run: { readonly projectId: ProjectId; readonly subject: JudgedSubject },
): boolean {
  switch (scope.kind) {
    case 'tenant':
      return true;
    case 'project':
      return scope.projectId === run.projectId;
    case 'agent':
      return (
        scope.projectId === run.projectId &&
        run.subject.kind === 'agent' &&
        run.subject.id === scope.agentId
      );
  }
}

// ---------- judgments ----------

export const VERDICTS = ['yes', 'no'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What a judged run ran: an agent at a version, or a flow at a version. */
export interface JudgedSubject {
  readonly kind: 'agent' | 'flow';
  readonly id: string;
  readonly version: string;
}

/** The judged item of a run's output. */
export interface JudgedItem {
  /** The caller's stable id for the item, e.g. a matched case's id. */
  readonly key: string;
  /** Where the item is in the run's output, as a JSON Pointer (RFC 6901), e.g. `/matches/2`. */
  readonly pointer?: string;
  /** The item's position in a ranked list (0 = first). */
  readonly rank?: number;
}

/** Who asserted a judgment: the authenticated caller, never a typed name. */
export interface JudgmentAssertedBy {
  readonly kind: 'user' | 'service';
  /** A user id, or for a service token its token or session id. */
  readonly id: string;
}

export interface Judgment {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly runId: string;
  readonly subject: JudgedSubject;
  readonly item: JudgedItem;
  readonly verdict: Verdict;
  readonly reason?: string;
  /** The judge's class; absent for an unclassified judgment (weight 1). */
  readonly judgeClassId?: string;
  readonly assertedBy: JudgmentAssertedBy;
  /** The app's opaque id for its end user who judged, when an app judged on their behalf. */
  readonly participantId?: string;
  readonly createdAt: string;
  /** Set when the judgment was removed or superseded. */
  readonly unregisteredAt?: string;
  /** The judgment that replaced this one. */
  readonly supersededBy?: string;
}

/**
 * What a judged agent turn read besides its input, captured when it was
 * first judged, so the turn can later be replayed faithfully: the
 * conversation before it and the context its retrievals returned. (Its
 * tool calls and results, provider and model are in its output.)
 */
export interface JudgedRunContext {
  /** The conversation's messages before the turn, oldest first (at most the last 200). */
  readonly history?: readonly unknown[];
  /** Whether older messages were left out of `history`. */
  readonly historyTruncated?: boolean;
  /** What the turn's retrievals returned. */
  readonly retrieved?: unknown;
}

/** The stored copies of a judged run. */
export interface JudgedRunCopy {
  readonly runId: string;
  readonly subject: JudgedSubject;
  readonly input: unknown;
  readonly output: unknown;
  /** Absent for runs judged before context was captured, and for flow runs. */
  readonly context?: JudgedRunContext;
  readonly capturedAt: string;
}

export interface JudgmentWithCopies extends Judgment {
  /** The run's input and output as they were when it was first judged. */
  readonly run: JudgedRunCopy;
  /** The judged item's value, when the judgment pointed at it. */
  readonly itemValue?: unknown;
}

export interface JudgmentRecordInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly runId: string;
  /** The run's copy, stored on its first judgment. */
  readonly run: {
    readonly subject: JudgedSubject;
    readonly input: unknown;
    readonly output: unknown;
    readonly context?: JudgedRunContext;
  };
  readonly item: JudgedItem;
  /** The item's value at `item.pointer`, resolved by the route from the run's output. */
  readonly itemValue?: unknown;
  readonly verdict: Verdict;
  readonly reason?: string;
  readonly judgeClassId?: string;
  readonly assertedBy: JudgmentAssertedBy;
  readonly participantId?: string;
}

export interface JudgmentListInput {
  readonly tenantId: TenantId;
  readonly scope?: ListScope;
  readonly runId?: string;
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId?: string;
  readonly verdict?: Verdict;
  readonly judgeClassId?: string;
  readonly participantId?: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface JudgmentPage {
  readonly data: readonly Judgment[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface JudgmentGetInput {
  readonly tenantId: TenantId;
  readonly judgmentId: string;
}

export interface JudgedRunListInput {
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId?: string;
  /** Runs first judged at or after this time (ISO 8601). */
  readonly since?: string;
  /** Runs first judged before this time (ISO 8601). */
  readonly until?: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface JudgedRunWithJudgments {
  readonly projectId: ProjectId;
  readonly run: JudgedRunCopy;
  /** The run's live judgments. */
  readonly judgments: readonly Judgment[];
}

export interface JudgedRunPage {
  readonly data: readonly JudgedRunWithJudgments[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}
