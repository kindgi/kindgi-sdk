// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { REVIEWER_ROLE_RANK, type ReviewerRole } from '@kindgi/authz';
import type { Cursor, ListScope, ProjectId, ScopeSegment, TenantId } from '@kindgi/types';

import type { ExpectedDecisions } from './expected-decisions.js';

/**
 * Caller-plugged surface for corrections: a person says yes or no, with an
 * optional reason, about one item of a run's output. A correction may name a
 * **judge class** ("expert", "user", …: the deployment's own names) that
 * carries a weight, so later metrics can weigh corrections. Classes are
 * optional: an unclassified correction counts with weight 1, so correcting
 * needs no setup.
 *
 * A correction keeps **copies** of what was corrected: the run's input and
 * output (once per run) and the corrected item. The copies outlive the run's
 * own retention, so a set of corrected cases stays stable when the run is
 * purged.
 *
 * Who corrected: `assertedBy` is the authenticated caller (a user, or a
 * service token such as an app's API key). It is never taken from the
 * request body. When an app corrects on behalf of one of its own users, it
 * passes that user's opaque id as `participantId`.
 *
 * One live correction per (run, item key, asserting principal, participant):
 * recording another supersedes the previous one, which stays as history.
 *
 * Every method is tenant-scoped. Deletes are soft (`unregister`); purging
 * follows the retention policies for the `correction` and `judge_class`
 * domains.
 */
export interface CorrectionRegistryBinding {
  /** Create a judge class. `name-taken` when a live class of that scope has the name. */
  createClass(input: JudgeClassCreateInput): Promise<JudgeClassCreateOutcome>;
  /** Live classes, newest first, cursor-paginated; `scope` narrows to one scope. */
  listClasses(input: JudgeClassListInput): Promise<JudgeClassPage>;
  /**
   * One class, or `null` when unknown. `includeUnregistered` also returns
   * a retired class (corrections keep naming theirs).
   */
  getClass(input: JudgeClassGetInput): Promise<JudgeClass | null>;
  /** Change a live class's weight or description; `null` when unknown or retired. */
  updateClass(input: JudgeClassUpdateInput): Promise<JudgeClass | null>;
  /** Retire a class: no new corrections may name it. `false` when unknown or already retired. */
  unregisterClass(input: JudgeClassGetInput): Promise<{ readonly unregistered: boolean }>;

  /**
   * Record a correction. The first correction of a run also stores the run's
   * copy (`run`); later ones keep the stored copy. Supersedes the live
   * correction with the same run, item key, `assertedBy` and `participantId`.
   */
  record(input: CorrectionRecordInput): Promise<Correction>;
  /** Live corrections, newest first, cursor-paginated. */
  list(input: CorrectionListInput): Promise<CorrectionPage>;
  /** One correction (live or not) with its copies, or `null` when unknown. */
  get(input: CorrectionGetInput): Promise<CorrectionWithCopies | null>;
  /** Soft-delete a live correction. `false` when unknown or already removed. */
  unregister(input: CorrectionGetInput): Promise<{ readonly unregistered: boolean }>;
  /**
   * Corrected runs with their copies and live corrections, newest first:
   * what a test set is built from. Optional (a binding without it can't
   * build test sets from corrections). A comparison's replay is never one of
   * them (`isReplayCopy`): correcting a replay's answer is evidence for that
   * comparison, not a case of its own.
   */
  listCorrectedRuns?(input: CorrectedRunListInput): Promise<CorrectedRunPage>;
}

// ---------- judge classes ----------

/**
 * Where a class applies: the whole tenant, one project, or one agent in a
 * project. A correction may name a class whose scope covers its run.
 */
export type JudgeClassScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'project'; readonly projectId: ProjectId }
  | { readonly kind: 'agent'; readonly projectId: ProjectId; readonly agentId: string };

export const JUDGE_CLASS_SCOPE_KINDS = ['tenant', 'project', 'agent'] as const;
export type JudgeClassScopeKind = (typeof JUDGE_CLASS_SCOPE_KINDS)[number];

/**
 * Who may assert a judge class (T200): every part that's set must hold.
 * Absent: anyone who may correct the run may assert the class, as before.
 * A class with one is *restricted*; a correction recorded while it is
 * carries `restricted`, and a comparison weighted `restricted-only`
 * counts only those.
 */
export interface JudgeClassAssertableBy {
  /** The caller's reviewer role is at least this (its token's, or the roster's). */
  readonly minReviewerRole?: ReviewerRole;
  /** Users, service tokens, or both. */
  readonly principalKinds?: readonly ('user' | 'service')[];
  /** Only these principals: user ids, or service token ids. */
  readonly principalIds?: readonly string[];
}

/** Who asserts a correction, as `JudgeClassAssertableBy` checks it. */
export interface JudgeClassAsserter {
  readonly kind: 'user' | 'service';
  readonly id: string;
  /** The caller's reviewer role; absent for a caller who isn't a reviewer. */
  readonly reviewerRole?: ReviewerRole;
}

/** Why `asserter` may not assert a class with `assertableBy`, or `undefined` when they may. */
export function whyNotAssertable(
  assertableBy: JudgeClassAssertableBy,
  asserter: JudgeClassAsserter,
): string | undefined {
  if (
    assertableBy.principalKinds !== undefined &&
    !assertableBy.principalKinds.includes(asserter.kind)
  ) {
    return `only ${assertableBy.principalKinds.map((k) => (k === 'user' ? 'users' : 'service tokens')).join(' and ')} may assert it`;
  }
  if (assertableBy.principalIds !== undefined && !assertableBy.principalIds.includes(asserter.id)) {
    return "it's restricted to named people or tokens, and you aren't one of them";
  }
  if (assertableBy.minReviewerRole !== undefined) {
    const need = assertableBy.minReviewerRole;
    const role = asserter.reviewerRole;
    if (role === undefined || REVIEWER_ROLE_RANK[role] < REVIEWER_ROLE_RANK[need]) {
      return `it needs a ${need} reviewer or above${role === undefined ? ", and you aren't a reviewer" : `; you're a ${role} reviewer`}`;
    }
  }
  return undefined;
}

export interface JudgeClass {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly scope: JudgeClassScope;
  /** The deployment's own word for the class: "expert", "user", "arbitrator"… */
  readonly name: string;
  /** How much a correction of this class counts (≥ 0); an unclassified correction counts 1. */
  readonly weight: number;
  readonly description?: string;
  /** Who may assert it; absent: anyone who may correct the run (T200). */
  readonly assertableBy?: JudgeClassAssertableBy;
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
  readonly assertableBy?: JudgeClassAssertableBy;
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
  /** Who may assert it; `null` lifts the restriction. Absent: unchanged. */
  readonly assertableBy?: JudgeClassAssertableBy | null;
}

/** Whether a class's scope covers a run in `projectId` whose subject is `subject`. */
export function judgeClassApplies(
  scope: JudgeClassScope,
  run: { readonly projectId: ProjectId; readonly subject: CorrectedSubject },
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

// ---------- corrections ----------

export const VERDICTS = ['yes', 'no'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What a corrected run ran: an agent at a version, or a flow at a version. */
export interface CorrectedSubject {
  readonly kind: 'agent' | 'flow';
  readonly id: string;
  readonly version: string;
}

/** The corrected item of a run's output. */
export interface CorrectedItem {
  /** The caller's stable id for the item, e.g. a matched case's id. */
  readonly key: string;
  /** Where the item is in the run's output, as a JSON Pointer (RFC 6901), e.g. `/matches/2`. */
  readonly pointer?: string;
  /** The item's position in a ranked list (0 = first). */
  readonly rank?: number;
}

/** Who asserted a correction: the authenticated caller, never a typed name. */
export interface CorrectionAssertedBy {
  readonly kind: 'user' | 'service';
  /** A user id, or for a service token its token or session id. */
  readonly id: string;
}

export interface Correction {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly runId: string;
  readonly subject: CorrectedSubject;
  readonly item: CorrectedItem;
  readonly verdict: Verdict;
  readonly reason?: string;
  /** The expert's correction of the run's decisions, when they gave one. */
  readonly correction?: ExpectedDecisions;
  /** The judge's class; absent for an unclassified correction (weight 1). */
  readonly judgeClassId?: string;
  /**
   * Set when the class was restricted (`assertableBy`) when the correction
   * was recorded, so whoever recorded it was checked against it. A restriction added
   * or lifted later doesn't change it (T200).
   */
  readonly restricted?: true;
  readonly assertedBy: CorrectionAssertedBy;
  /** The app's opaque id for its end user who corrected it, when an app corrected it on their behalf. */
  readonly participantId?: string;
  readonly createdAt: string;
  /** Set when the correction was removed or superseded. */
  readonly unregisteredAt?: string;
  /** The correction that replaced this one. */
  readonly supersededBy?: string;
}

/**
 * What a corrected agent turn read besides its input, captured when it was
 * first corrected, so the turn can later be replayed faithfully: the
 * conversation before it and the context its retrievals returned. (Its
 * tool calls and results, provider and model are in its output.)
 */
export interface CorrectedRunContext {
  /** The conversation's messages before the turn, oldest first (at most the last 200). */
  readonly history?: readonly unknown[];
  /** Whether older messages were left out of `history`. */
  readonly historyTruncated?: boolean;
  /** What the turn's retrievals returned. */
  readonly retrieved?: unknown;
  /** Messages of earlier conversations the turn recalled. A replay of the turn reuses them. */
  readonly recalled?: unknown;
  /**
   * The reviewer's decision at the turn's session approval gate, when the
   * turn waited on one. A replay of the turn follows it.
   */
  readonly sessionApproval?: { readonly approved: boolean; readonly rationale?: string };
  /** For a flow run: what it did (see `CorrectedFlowContext`). */
  readonly flow?: CorrectedFlowContext;
  /**
   * The env values each tool's calls were sent (`needsSpec.env`), by tool
   * id: its first call's, as the run recorded them. A replay sends them to
   * a read-only tool it runs live, so the tool reads the config the run
   * saw, not today's. Absent for a run from before env was recorded.
   */
  readonly toolEnv?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * The run a comparison's replay re-ran, when the corrected run is a replay:
   * stamped at its first correction (a run's `replayOf`). A test set leaves a
   * replay out (`isReplayCopy`).
   */
  readonly replayOf?: string;
}

/**
 * Whether a corrected run's copy is a comparison's replay, which a test set
 * leaves out: its context names the run it replays (`replayOf`, stamped at
 * its first correction), or, for a copy stored before that stamp, an agent
 * turn's output carries its replay report (`replay.of`, every replayed
 * turn's). A flow replay corrected before the stamp can't be told apart.
 */
export function isReplayCopy(copy: {
  readonly output: unknown;
  readonly context?: CorrectedRunContext;
}): boolean {
  if (copy.context?.replayOf !== undefined) return true;
  const output = copy.output;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return false;
  const replay = (output as Record<string, unknown>).replay;
  return (
    typeof replay === 'object' &&
    replay !== null &&
    typeof (replay as Record<string, unknown>).of === 'string'
  );
}

/** One tool call a corrected run made, and its result. */
export interface CorrectedToolCall {
  /** The run that made it: the flow run, a sub-flow's run, or an agent step's turn. */
  readonly runId: string;
  /** The tool node that made it, or the agent step whose turn did. */
  readonly nodeId?: string;
  /** The loop iteration, when the node is in a loop body. */
  readonly scope?: string;
  readonly toolId: string;
  readonly arguments: unknown;
  readonly result: unknown;
  /**
   * An agent step's turn kept the result as outside data (its tool
   * message's `fromEvent`): another system's answer to a paused call, or a
   * result its tool says is outside data. A replay hands it to the model
   * as data, as the turn did. Absent for a tool node's call.
   */
  readonly fromEvent?: true;
}

/** One agent step of a corrected flow run: the turn it started. */
export interface CorrectedFlowStep {
  readonly runId: string;
  readonly nodeId?: string;
  readonly scope?: string;
  readonly agentId: string;
  readonly agentVersion: string;
  /** What the turn's retrievals returned. */
  readonly retrieved?: unknown;
  /** Messages of earlier conversations the turn recalled. */
  readonly recalled?: unknown;
}

/**
 * What a corrected flow run did, kept at its first correction: every tool
 * call it made with its result (at its tool nodes, in its agent steps'
 * turns and in its sub-flows), at most 500, and its agent steps.
 */
export interface CorrectedFlowContext {
  readonly calls: readonly CorrectedToolCall[];
  readonly steps: readonly CorrectedFlowStep[];
  /** More calls were made than were kept. */
  readonly truncated?: boolean;
}

/** The stored copies of a corrected run. */
export interface CorrectedRunCopy {
  readonly runId: string;
  readonly subject: CorrectedSubject;
  readonly input: unknown;
  readonly output: unknown;
  /** Absent for runs corrected before context was captured, and for flow runs. */
  readonly context?: CorrectedRunContext;
  /**
   * The segment path the run was started with (empty: none). Absent for
   * runs corrected before it was captured: such a run belongs to no segment.
   */
  readonly segments?: readonly ScopeSegment[];
  readonly capturedAt: string;
}

export interface CorrectionWithCopies extends Correction {
  /** The run's input and output as they were when it was first corrected. */
  readonly run: CorrectedRunCopy;
  /** The corrected item's value, when the correction pointed at it. */
  readonly itemValue?: unknown;
}

export interface CorrectionRecordInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly runId: string;
  /** The run's copy, stored on its first correction. */
  readonly run: {
    readonly subject: CorrectedSubject;
    readonly input: unknown;
    readonly output: unknown;
    readonly context?: CorrectedRunContext;
    /** The segment path the run was started with (empty: none). */
    readonly segments?: readonly ScopeSegment[];
  };
  readonly item: CorrectedItem;
  /** The item's value at `item.pointer`, resolved by the route from the run's output. */
  readonly itemValue?: unknown;
  readonly verdict: Verdict;
  readonly reason?: string;
  /** The expert's correction of the run's decisions, validated by the route. */
  readonly correction?: ExpectedDecisions;
  readonly judgeClassId?: string;
  /** The class was restricted, and whoever recorded it met it (see `Correction.restricted`). */
  readonly restricted?: true;
  readonly assertedBy: CorrectionAssertedBy;
  readonly participantId?: string;
}

export interface CorrectionListInput {
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

export interface CorrectionPage {
  readonly data: readonly Correction[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface CorrectionGetInput {
  readonly tenantId: TenantId;
  readonly correctionId: string;
}

export interface CorrectedRunListInput {
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId?: string;
  /** Runs first corrected at or after this time (ISO 8601). */
  readonly since?: string;
  /** Runs first corrected before this time (ISO 8601). */
  readonly until?: string;
  /**
   * Runs started in this segment path or below it (their captured
   * `segments` start with it). A run corrected before segments were captured
   * is in none.
   */
  readonly segments?: readonly ScopeSegment[];
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface CorrectedRunWithCorrections {
  readonly projectId: ProjectId;
  readonly run: CorrectedRunCopy;
  /** The run's live corrections. */
  readonly corrections: readonly Correction[];
}

export interface CorrectedRunPage {
  readonly data: readonly CorrectedRunWithCorrections[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}
