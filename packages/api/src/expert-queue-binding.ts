// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Result, TenantId, Timestamp } from '@kindgi/types';

/**
 * Which runs need a correction: a project's queue rules, and the queue
 * they fill. A rule says which of the project's runs to ask a person to
 * correct (an agent or flow, its version, how the run ended, a share of
 * them, at most so many waiting at once); a run that matches when it ends
 * is queued once, however many rules matched, and its item closes when
 * every matching rule has the correction it wants.
 *
 * Rules only list runs: nothing here starts a model or spends. A rule is
 * versioned as release gates are: each change is a new version, the
 * latest live one applies, nothing is deleted.
 */

/** How a queued run ended. */
export type ExpertQueueRunStatus = 'completed' | 'failed' | 'cancelled';

/** Which of a project's runs a rule matches, at their end. Every field narrows; absent fields don't. */
export interface QueueRuleWhen {
  /** Runs of these agents (their own runs, not their turns as a flow's step). */
  readonly agentIds?: readonly string[];
  /** Runs of these flows. */
  readonly flowIds?: readonly string[];
  /**
   * These versions exactly, or `pinned`: runs that got the agent's pinned version,
   * not one the caller named. Runs from before the runtime recorded how their
   * version was chosen never match `pinned`.
   */
  readonly versions?: readonly string[];
  /**
   * How the run ended. Only `completed` today: a correction needs a completed
   * run, so `failed` and `cancelled` are refused. Absent: `completed`.
   */
  readonly status?: readonly ExpertQueueRunStatus[];
  /** Dry runs are left out unless this is `true`. Replays never match. */
  readonly includeDryRuns?: boolean;
}

/** What a rule is, as a caller writes it. */
export interface QueueRuleSpec {
  readonly name: string;
  readonly when: QueueRuleWhen;
  /**
   * The share of matching runs queued, 0 < sample ≤ 1. Decided by the run and
   * rule ids, the same every time and across the rule's versions: raising it
   * keeps the runs it took before. Default 1.
   */
  readonly sample?: number;
  /** Add nothing while this rule has this many open items. Absent: no cap. */
  readonly maxOpen?: number;
  /** Whose correction the rule wants: a correction of this group closes it. Absent: any correction does. */
  readonly correctorGroupId?: string;
  /** Default `true`. */
  readonly enabled?: boolean;
}

/**
 * A change to a rule: the fields given replace the latest version's
 * (`when` whole). `null` removes `maxOpen` or `correctorGroupId`.
 */
export interface QueueRulePatch {
  readonly name?: string;
  readonly when?: QueueRuleWhen;
  readonly sample?: number;
  readonly maxOpen?: number | null;
  readonly correctorGroupId?: string | null;
  readonly enabled?: boolean;
}

/** One version of a rule. */
export interface QueueRule {
  readonly ruleId: string;
  readonly projectId: string;
  readonly version: number;
  readonly name: string;
  readonly when: QueueRuleWhen;
  readonly sample: number;
  readonly maxOpen?: number;
  readonly correctorGroupId?: string;
  readonly enabled: boolean;
  /** Who wrote this version (a principal reference), when known. */
  readonly createdBy?: string;
  readonly createdAt: Timestamp;
  /** Set when the rule was unregistered. */
  readonly unregisteredAt?: Timestamp;
}

/**
 * Where a queued run stands. `erased`: the run's content is gone (erased,
 * or the run purged); the item shows nothing of it.
 */
export type ExpertQueueState = 'open' | 'corrected' | 'dismissed' | 'erased';

/** A rule that queued a run, at the version that queued it. */
export interface ExpertQueueItemRule {
  readonly ruleId: string;
  readonly version: number;
}

/** One queued run: never its content, only what it was and where it stands. */
export interface ExpertQueueItem {
  readonly runId: string;
  readonly projectId: string;
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId: string;
  readonly runStatus: ExpertQueueRunStatus;
  readonly completedAt: Timestamp;
  /** The rules that queued it, each at the version that did. */
  readonly rules: readonly ExpertQueueItemRule[];
  /** The corrector groups its rules want; `anyCorrection` when one of them wants any correction. */
  readonly wantedGroupIds: readonly string[];
  readonly anyCorrection: boolean;
  /** The live corrections on the run so far, by group (`null`: unclassified). */
  readonly progress: {
    readonly total: number;
    readonly byGroup: readonly {
      readonly correctorGroupId: string | null;
      readonly count: number;
    }[];
  };
  readonly addedAt: Timestamp;
  readonly state: ExpertQueueState;
  readonly closedAt?: Timestamp;
  /** Who dismissed or reopened it last (a principal reference). */
  readonly closedBy?: string;
  readonly reason?: string;
}

/**
 * A rule's results since a time, by the rule's version and the agent's:
 * never pooled with another rule's, or across two versions of one rule
 * (each version is its own sampling design).
 */
export interface QueueRuleResults {
  readonly ruleId: string;
  readonly since?: Timestamp;
  /** Newest rule version first. */
  readonly groups: readonly QueueRuleResultGroup[];
}

/** One rule version's runs of one agent version. `added` = `open` + `corrected` + `dismissed` + `erased`. */
export interface QueueRuleResultGroup {
  readonly ruleVersion: number;
  /** `null`: a flow run, or a run from before versions were recorded. */
  readonly agentVersion: string | null;
  readonly added: number;
  readonly open: number;
  readonly corrected: number;
  readonly dismissed: number;
  readonly erased: number;
  /**
   * Runs the rule matched and sampled but didn't queue, because `maxOpen`
   * were waiting. Non-zero: the queued runs lean toward quiet times.
   * `added` + `skippedByCap` = every run the rule matched and sampled. A
   * skipped run counts here even when another rule queued it.
   */
  readonly skippedByCap: number;
  /** Live corrections on the queued runs: each is one person's verdict on one item of a run's output. */
  readonly corrections: number;
  /**
   * The queued runs with at least one live correction: the runs `corrections`
   * and `yesShare` come from, whatever their queue item's state now (still
   * `open`, closed as `corrected`, or dismissed after someone corrected it).
   * Several people correcting one run make
   * several corrections but one run here, so a range can be sized by runs.
   * Absent from a runtime that doesn't count them.
   */
  readonly runsWithCorrections?: number;
  /** The `yes` share of those corrections, each weighted by its group (unclassified: 1). `null` with no corrections. */
  readonly yesShare: number | null;
  /** The same corrections by group (`null`: unclassified), unweighted. */
  readonly byGroup: readonly QueueRuleGroupResult[];
}

export interface QueueRuleGroupResult {
  readonly correctorGroupId: string | null;
  readonly corrections: number;
  readonly yes: number;
}

/** What a rule would have queued among a project's recent runs. */
export interface QueueRulePreview {
  /** The recent runs looked at (top-level, not replays), newest first. */
  readonly considered: number;
  /** Of those, the ones the rule (with its sample) would have queued. `maxOpen` isn't applied. */
  readonly matched: number;
}

/** The outcome of queueing a rule's matches among recent runs ({@link ExpertQueueBinding.queueRecent}). */
export interface ExpertQueueRecentQueued {
  /** Matching recent runs this call newly queued for the rule: a new queue item, or the rule added to one already waiting for another rule. */
  readonly queued: number;
  /** Matching recent runs this rule had already queued and that are still open (deduped per `(rule, run)`). */
  readonly alreadyQueued: number;
  /**
   * Matching recent runs whose run was already corrected or dismissed: left as
   * they are, not re-queued. An already-erased run is no longer a match and
   * is counted nowhere, so `queued`, `alreadyQueued` and `alreadyReviewed`
   * together are the matches.
   */
  readonly alreadyReviewed: number;
}

export type ExpertQueueErrorCode =
  | 'queue-rule-not-found'
  | 'expert-queue-item-not-found'
  /** Dismissing an item that isn't open, or reopening one that wasn't dismissed. */
  | 'expert-queue-item-not-open'
  | 'corrector-group-not-found';

export interface ExpertQueueError {
  readonly code: ExpertQueueErrorCode;
  readonly message: string;
}

interface InProject {
  readonly tenantId: TenantId;
  readonly projectId: string;
}

export interface ExpertQueueListInput extends InProject {
  readonly state?: ExpertQueueState;
  readonly agentId?: string;
  readonly ruleId?: string;
  readonly correctorGroupId?: string;
  /** Only items any correction closes, or that want one of these groups (the caller's `forMe`). */
  readonly wantedFrom?: readonly string[];
  readonly addedAfter?: Timestamp;
  readonly closedAfter?: Timestamp;
  /** 0: only the `total`. */
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface ExpertQueuePage {
  readonly data: readonly ExpertQueueItem[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
  /** Every item the filters match, across pages. */
  readonly total: number;
}

export interface QueueRulePage {
  readonly data: readonly QueueRule[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface ExpertQueueBinding {
  createRule(
    input: InProject & { readonly spec: QueueRuleSpec; readonly by?: string },
  ): Promise<Result<QueueRule, ExpertQueueError>>;
  /** A new version with `patch` applied to the latest. */
  updateRule(
    input: InProject & {
      readonly ruleId: string;
      readonly patch: QueueRulePatch;
      readonly by?: string;
    },
  ): Promise<Result<QueueRule, ExpertQueueError>>;
  /** `false` when unknown or already unregistered. */
  unregisterRule(
    input: InProject & { readonly ruleId: string; readonly by?: string },
  ): Promise<{ readonly unregistered: boolean }>;
  /** The latest version, or `null` when unknown (`includeUnregistered` for a retired one). */
  getRule(
    input: InProject & { readonly ruleId: string; readonly includeUnregistered?: boolean },
  ): Promise<QueueRule | null>;
  /** Live rules (their latest versions), oldest first. */
  listRules(
    input: InProject & { readonly limit: number; readonly cursor?: Cursor },
  ): Promise<QueueRulePage>;
  /** Every version of a rule, newest first. */
  ruleVersions(
    input: InProject & {
      readonly ruleId: string;
      readonly limit: number;
      readonly cursor?: Cursor;
    },
  ): Promise<QueueRulePage>;
  /** Queued runs, oldest first. */
  listQueue(input: ExpertQueueListInput): Promise<ExpertQueuePage>;
  dismiss(
    input: InProject & { readonly runId: string; readonly by?: string; readonly reason?: string },
  ): Promise<Result<ExpertQueueItem, ExpertQueueError>>;
  reopen(
    input: InProject & { readonly runId: string; readonly by?: string },
  ): Promise<Result<ExpertQueueItem, ExpertQueueError>>;
  results(
    input: InProject & { readonly ruleId: string; readonly since?: Timestamp },
  ): Promise<Result<QueueRuleResults, ExpertQueueError>>;
  /**
   * What `spec` would have queued among the project's last `last` runs.
   * With an existing rule's `ruleId`, sampled as that rule samples: exactly
   * the runs it would take. Without, an estimate.
   */
  preview(
    input: InProject & {
      readonly spec: QueueRuleSpec;
      readonly last: number;
      readonly ruleId?: string;
    },
  ): Promise<QueueRulePreview>;
  /**
   * Queue the runs an existing rule matches among the project's recent
   * runs — `last` of them (newest first) and/or those completed at or
   * after `since` — sampled as the rule samples, deduped per `(rule, run)`
   * as run-end matching is. For catching a rule up on past runs; `maxOpen`
   * is not applied. At least one of `last`, `since` is given. The answer
   * splits the matches into `queued`, `alreadyQueued` and `alreadyReviewed`:
   * a run already corrected or dismissed is left as it is, and an erased run is
   * no longer a match.
   */
  queueRecent(
    input: InProject & {
      readonly ruleId: string;
      readonly last?: number;
      readonly since?: Timestamp;
      readonly by?: string;
    },
  ): Promise<Result<ExpertQueueRecentQueued, ExpertQueueError>>;
}
