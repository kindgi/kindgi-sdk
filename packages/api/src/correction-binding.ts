// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { REVIEWER_ROLE_RANK, type ReviewerRole } from '@kindgi/authz';
import type { Cursor, ListScope, ProjectId, ScopeSegment, TenantId } from '@kindgi/types';

import type { ExpectedCall } from './expected-decisions.js';
import type {
  TestCase,
  TestCaseAddInput,
  TestCaseGetInput,
  TestCaseListInput,
  TestCasePage,
  TestCaseRetireInput,
  TestCaseRetireOutcome,
  TestSetCounts,
  TestSetOfInput,
} from './test-case-binding.js';

/**
 * Caller-plugged surface for corrections: a person says whether a run's
 * decisions and its answer were right, and what was right instead. Each
 * correction has a status (open, being fixed, with the owner, fixed, won't
 * fix, removed) and is sorted to whoever fixes it. A correction may name a
 * **corrector group** ("expert", "user", …: the deployment's own names) that
 * carries a weight, so later metrics can weigh corrections. Groups are
 * optional: an unclassified correction counts with weight 1, so correcting
 * needs no setup.
 *
 * A correction keeps **copies** of what was corrected: the run's input and
 * output (once per run) and the corrected item. The copies outlive the run's
 * own retention, so a set of corrected cases stays stable when the run is
 * purged.
 *
 * Who corrected: `madeBy` is the authenticated caller (a user, or a
 * service token such as an app's API key). It is never taken from the
 * request body. When an app corrects on behalf of one of its own users, it
 * passes that user's opaque id as `participantId`.
 *
 * One live correction per (run, asserting principal, participant):
 * recording another supersedes the previous one, which stays as history.
 * A correction from before statuses reads as one: its rows on the run are
 * composed into it, open and unsorted.
 *
 * Every method is tenant-scoped. Deletes are soft (`unregister`); purging
 * follows the retention policies for the `correction` and `corrector_group`
 * domains.
 */
export interface CorrectionRegistryBinding {
  /** Create a corrector group. `name-taken` when a live group of that scope has the name. */
  createGroup(input: CorrectorGroupCreateInput): Promise<CorrectorGroupCreateOutcome>;
  /** Live groups, newest first, cursor-paginated; `scope` narrows to one scope. */
  listGroups(input: CorrectorGroupListInput): Promise<CorrectorGroupPage>;
  /**
   * One group, or `null` when unknown. `includeUnregistered` also returns
   * a retired group (corrections keep naming theirs).
   */
  getGroup(input: CorrectorGroupGetInput): Promise<CorrectorGroup | null>;
  /** Change a live group's weight or description; `null` when unknown or retired. */
  updateGroup(input: CorrectorGroupUpdateInput): Promise<CorrectorGroup | null>;
  /** Retire a group: no new corrections may name it. `false` when unknown or already retired. */
  unregisterGroup(input: CorrectorGroupGetInput): Promise<{ readonly unregistered: boolean }>;

  /**
   * Record a correction. The first correction of a run also stores the run's
   * copy (`run`); later ones keep the stored copy. Supersedes the live
   * correction with the same run, `madeBy` and `participantId`.
   */
  record(input: CorrectionRecordInput): Promise<Correction>;
  /** Live corrections, newest first, cursor-paginated. */
  list(input: CorrectionListInput): Promise<CorrectionPage>;
  /** One correction (live or not) with its copies, or `null` when unknown. */
  get(input: CorrectionGetInput): Promise<CorrectionWithCopies | null>;
  /**
   * Remove a live correction: its status becomes `removed`, and it can't
   * come back. `false` when unknown, superseded or already removed.
   */
  unregister(input: CorrectionGetInput): Promise<{ readonly unregistered: boolean }>;
  /** Change a live correction's status or sorting (see `CorrectionUpdateInput`). */
  update(input: CorrectionUpdateInput): Promise<CorrectionUpdateOutcome>;
  /** How many corrections are in each status. */
  counts(input: CorrectionCountsInput): Promise<CorrectionCounts>;
  /**
   * Where each of these corrections is, for whoever holds their ids (a
   * suggested change's evidence). Unknown, superseded and other tenants'
   * ids are left out; removed ones come back as `removed`.
   */
  correctionsByIds(input: CorrectionsByIdsInput): Promise<readonly CorrectionStanding[]>;
  /** A project's test set of an agent: how many cases it has (see `TEST_CASE_KINDS`). */
  testSet(input: TestSetOfInput): Promise<TestSetCounts>;
  /** A project's cases of an agent's test set, newest added first. */
  listCases(input: TestCaseListInput): Promise<TestCasePage>;
  /** One case of the agent's test set, retired or not, or `null` when it has none by that id. */
  getCase(input: TestCaseGetInput): Promise<TestCase | null>;
  /**
   * Add a case by hand. It's stored as a correction is, but it has no
   * status, is never sorted, and nothing that counts corrections counts it.
   */
  addCase(input: TestCaseAddInput): Promise<TestCase>;
  /** Retire a case: it stays listed, and no test run checks it again. */
  retireCase(input: TestCaseRetireInput): Promise<TestCaseRetireOutcome>;
}

// ---------- corrector groups ----------

/**
 * Where a group applies: the whole tenant, one project, or one agent in a
 * project. A correction may name a group whose scope covers its run.
 */
export type CorrectorGroupScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'project'; readonly projectId: ProjectId }
  | { readonly kind: 'agent'; readonly projectId: ProjectId; readonly agentId: string };

export const CORRECTOR_GROUP_SCOPE_KINDS = ['tenant', 'project', 'agent'] as const;
export type CorrectorGroupScopeKind = (typeof CORRECTOR_GROUP_SCOPE_KINDS)[number];

/**
 * Who may assert a corrector group (T200): every part that's set must hold.
 * Absent: anyone who may correct the run may assert the group, as before.
 * A group with one is *restricted*; a correction recorded while it is
 * carries `expert`, and a comparison weighted `experts-only`
 * counts only those.
 */
export interface CorrectorGroupAssertableBy {
  /** The caller's reviewer role is at least this (its token's, or the roster's). */
  readonly minReviewerRole?: ReviewerRole;
  /** Users, service tokens, or both. */
  readonly principalKinds?: readonly ('user' | 'service')[];
  /** Only these principals: user ids, or service token ids. */
  readonly principalIds?: readonly string[];
}

/** Who asserts a correction, as `CorrectorGroupAssertableBy` checks it. */
export interface CorrectorGroupAsserter {
  readonly kind: 'user' | 'service';
  readonly id: string;
  /** The caller's reviewer role; absent for a caller who isn't a reviewer. */
  readonly reviewerRole?: ReviewerRole;
}

/** Why `asserter` may not assert a group with `assertableBy`, or `undefined` when they may. */
export function whyNotAssertable(
  assertableBy: CorrectorGroupAssertableBy,
  asserter: CorrectorGroupAsserter,
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

export interface CorrectorGroup {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly scope: CorrectorGroupScope;
  /** The deployment's own word for the group: "expert", "user", "arbitrator"… */
  readonly name: string;
  /** How much a correction of this group counts (≥ 0); an unclassified correction counts 1. */
  readonly weight: number;
  readonly description?: string;
  /** Who may assert it; absent: anyone who may correct the run (T200). */
  readonly assertableBy?: CorrectorGroupAssertableBy;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the group was retired. */
  readonly unregisteredAt?: string;
}

export interface CorrectorGroupCreateInput {
  readonly tenantId: TenantId;
  readonly scope: CorrectorGroupScope;
  readonly name: string;
  readonly weight: number;
  readonly description?: string;
  readonly assertableBy?: CorrectorGroupAssertableBy;
}

export type CorrectorGroupCreateOutcome =
  | { readonly kind: 'created'; readonly correctorGroup: CorrectorGroup }
  | { readonly kind: 'name-taken' };

export interface CorrectorGroupListInput {
  readonly tenantId: TenantId;
  readonly scope?: CorrectorGroupScope;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface CorrectorGroupPage {
  readonly data: readonly CorrectorGroup[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface CorrectorGroupGetInput {
  readonly tenantId: TenantId;
  readonly correctorGroupId: string;
  readonly includeUnregistered?: boolean;
}

export interface CorrectorGroupUpdateInput {
  readonly tenantId: TenantId;
  readonly correctorGroupId: string;
  readonly weight?: number;
  readonly description?: string;
  /** Who may assert it; `null` lifts the restriction. Absent: unchanged. */
  readonly assertableBy?: CorrectorGroupAssertableBy | null;
}

/** Whether a group's scope covers a run in `projectId` whose subject is `subject`. */
export function correctorGroupApplies(
  scope: CorrectorGroupScope,
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

/** A verdict on a run's decisions, its answer, or one item of a ranked answer. */
export const VERDICTS = ['right', 'wrong'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Where a correction is in being fixed. `with-owner` while the agent's
 * owner decides (every `decisions: 'wrong'` starts there); `fixed` only
 * when a pin or a deploy fixed it, or when it said nothing was wrong;
 * `removed` can't come back.
 */
export const CORRECTION_STATUSES = [
  'open',
  'being-fixed',
  'with-owner',
  'fixed',
  'wont-fix',
  'removed',
] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

/** The statuses `not-fixed` is short for. */
export const NOT_FIXED_STATUSES = ['open', 'being-fixed', 'with-owner'] as const;

/** Who works on a correction: Improve, a developer, or the agent's owner. */
export const CORRECTION_SORTED_TO = ['improve', 'developer', 'owner'] as const;
export type CorrectionSortedTo = (typeof CORRECTION_SORTED_TO)[number];

/** What sorted a correction: the fix job, the rule at save, or the caller who re-sorted it. */
export type CorrectionSortedBy =
  | { readonly kind: 'fix-job' }
  | { readonly kind: 'rule' }
  | { readonly kind: 'user' | 'service'; readonly id: string };

export interface CorrectionSorted {
  readonly by: CorrectionSortedBy;
  readonly reason?: string;
  readonly at: string;
}

/** The work fixing a correction, while it's `being-fixed`. */
export type CorrectionLink =
  | { readonly kind: 'improve-run'; readonly id: string }
  | { readonly kind: 'suggested-change'; readonly id: string }
  | { readonly kind: 'pull-request'; readonly url: string };

/** How a `fixed` correction was fixed. */
export const CORRECTION_FIXED_HOW = ['pin', 'latest', 'recorded-right'] as const;
export type CorrectionFixedHow = (typeof CORRECTION_FIXED_HOW)[number];

export interface CorrectionFixedIn {
  /** The version that fixed it; absent for `recorded-right`, which nothing had to fix. */
  readonly version?: string;
  readonly how: CorrectionFixedHow;
  readonly by?: CorrectionMadeBy;
  readonly at: string;
}

/** A person's note on a status: why Won't fix, or why it went back to Open. */
export interface CorrectionStatusNote {
  readonly text: string;
  readonly by: CorrectionMadeBy;
  readonly at: string;
}

/** One item of a ranked answer, and whether it was right there. */
export interface CorrectedAnswerItem extends CorrectedItem {
  readonly verdict: Verdict;
}

/** What a corrected run ran: an agent at a version, or a flow at a version. */
export interface CorrectedSubject {
  readonly kind: 'agent' | 'flow';
  readonly id: string;
  readonly version: string;
}

/** The corrected item of a run's output. */
export interface CorrectedItem {
  /** The caller's stable id for the item, e.g. a matched case's id, never the item's own text. */
  readonly key: string;
  /** Where the item is in the run's output, as a JSON Pointer (RFC 6901), e.g. `/matches/2`. */
  readonly pointer?: string;
  /** The item's position in a ranked list (0 = first). */
  readonly rank?: number;
}

/** Who asserted a correction: the authenticated caller, never a typed name. */
export interface CorrectionMadeBy {
  readonly kind: 'user' | 'service';
  /** A user id, or for a service token its token or session id. */
  readonly id: string;
}

/**
 * A person's correction of one run: whether its decisions (the tool calls)
 * and its answer were right, and what was right instead. It says at least
 * one of `decisions` and `answer`.
 */
export interface Correction {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly runId: string;
  readonly subject: CorrectedSubject;
  /** Whether the run's decisions were right. Absent when the correction says nothing about them. */
  readonly decisions?: Verdict;
  /** With `decisions: 'wrong'`: the calls that should have been made. */
  readonly shouldCall?: readonly ExpectedCall[];
  /** With `decisions: 'wrong'`: the tools that shouldn't have been called. */
  readonly mustNotCall?: readonly string[];
  /** Whether the run's answer was right. Absent when the correction says nothing about it. */
  readonly answer?: Verdict;
  /** With `answer: 'wrong'`: what it should have said. */
  readonly shouldSay?: string;
  readonly why?: string;
  /** For an answer that's a ranked list: each item, and whether it was right there. */
  readonly items?: readonly CorrectedAnswerItem[];
  readonly status: CorrectionStatus;
  /** Absent while it's unsorted. */
  readonly sortedTo?: CorrectionSortedTo;
  readonly sorted?: CorrectionSorted;
  /** Present while it's `being-fixed`. */
  readonly link?: CorrectionLink;
  /** Present while it's `fixed`. */
  readonly fixedIn?: CorrectionFixedIn;
  readonly statusNote?: CorrectionStatusNote;
  /** The corrector's group; absent for an unclassified correction (weight 1). */
  readonly correctorGroupId?: string;
  /**
   * Set when the group was restricted (`assertableBy`) when the correction
   * was recorded, so whoever recorded it was checked against it. A restriction added
   * or lifted later doesn't change it (T200).
   */
  readonly expert?: true;
  readonly madeBy: CorrectionMadeBy;
  /** The app's opaque id for its end user who corrected it, when an app corrected it on their behalf. */
  readonly participantId?: string;
  readonly createdAt: string;
  /** When it last changed: its `createdAt` until something changes it. */
  readonly updatedAt: string;
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
  /** What the correction says, validated by the route (see `Correction`). */
  readonly decisions?: Verdict;
  readonly shouldCall?: readonly ExpectedCall[];
  readonly mustNotCall?: readonly string[];
  readonly answer?: Verdict;
  readonly shouldSay?: string;
  readonly why?: string;
  readonly items?: readonly CorrectedAnswerItem[];
  readonly correctorGroupId?: string;
  /** The group was restricted, and whoever recorded it met it (see `Correction.expert`). */
  readonly expert?: true;
  readonly madeBy: CorrectionMadeBy;
  readonly participantId?: string;
  /** Where it's sorted at save, by the route's rule: the status, and `sortedTo` when sorted. */
  readonly status: CorrectionStatus;
  readonly sortedTo?: CorrectionSortedTo;
  readonly sorted?: CorrectionSorted;
  /** For a correction that says nothing was wrong: `recorded-right`. */
  readonly fixedIn?: CorrectionFixedIn;
}

export interface CorrectionListInput {
  readonly tenantId: TenantId;
  readonly scope?: ListScope;
  readonly runId?: string;
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId?: string;
  /** Any of these statuses. Absent: every status but `removed`, which comes back only when asked for. */
  readonly statuses?: readonly CorrectionStatus[];
  /** Any of these, with `none` for unsorted. */
  readonly sortedTo?: readonly (CorrectionSortedTo | 'none')[];
  /** Only experts' corrections (under a restricted group), or only end users' (`participantId`, no restricted group). Absent: all. */
  readonly from?: 'experts' | 'end-users';
  /** Made at or after this time (ISO 8601). */
  readonly since?: string;
  /** Made before this time (ISO 8601). */
  readonly until?: string;
  /** Only this author's (kind and id). */
  readonly madeBy?: CorrectionMadeBy;
  readonly correctorGroupId?: string;
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

/**
 * A change to a live correction's status or sorting. It applies only while
 * the correction still has the `expected` status and `sortedTo` the route
 * checked the change against, so two changes at once can't both apply.
 */
export interface CorrectionUpdateInput {
  readonly tenantId: TenantId;
  readonly correctionId: string;
  readonly expected: {
    readonly status: CorrectionStatus;
    readonly sortedTo: CorrectionSortedTo | null;
  };
  readonly status?: CorrectionStatus;
  /** `null` makes it unsorted. */
  readonly sortedTo?: CorrectionSortedTo | null;
  readonly sorted?: CorrectionSorted;
  /** `null` clears it. */
  readonly link?: CorrectionLink | null;
  /** `null` clears it. */
  readonly statusNote?: CorrectionStatusNote | null;
  /**
   * `null` clears it, when the status leaves `fixed` (`fixedIn` is there only
   * while it's fixed).
   */
  readonly fixedIn?: null;
}

export type CorrectionUpdateOutcome =
  | { readonly kind: 'updated'; readonly correction: Correction }
  | { readonly kind: 'not-found' }
  /** It changed since the route read it: `correction` is what it is now. */
  | { readonly kind: 'changed'; readonly correction: Correction };

/** Live corrections by status (`removed`: the removed ones), for an agent or a project. */
export interface CorrectionCountsInput {
  readonly tenantId: TenantId;
  readonly scope?: ListScope;
  readonly agentId?: string;
}

export interface CorrectionCounts {
  readonly open: number;
  readonly beingFixed: number;
  readonly withOwner: number;
  readonly fixed: number;
  readonly wontFix: number;
  readonly removed: number;
}

/** At most 500 ids. */
export interface CorrectionsByIdsInput {
  readonly tenantId: TenantId;
  readonly ids: readonly string[];
}

/** Where one correction is: its status, and `sortedTo` (`null` while unsorted). */
export interface CorrectionStanding {
  readonly id: string;
  readonly status: CorrectionStatus;
  readonly sortedTo: CorrectionSortedTo | null;
}
