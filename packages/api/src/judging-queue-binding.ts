// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Result, TenantId, Timestamp } from '@kindgi/types';

/**
 * Which runs need a judgment: a project's judging rules, and the queue
 * they fill. A rule says which of the project's runs to ask a person to
 * judge (an agent or flow, its version, how the run ended, a share of
 * them, at most so many waiting at once); a run that matches when it ends
 * is queued once, however many rules matched, and its item closes when
 * every matching rule has the judgment it wants.
 *
 * Rules only list runs: nothing here starts a model or spends. A rule is
 * versioned as gate policies are: each change is a new version, the
 * latest live one applies, nothing is deleted.
 */

/** How a queued run ended. */
export type JudgingRunStatus = 'completed' | 'failed' | 'cancelled';

/** Which of a project's runs a rule matches, at their end. Every field narrows; absent fields don't. */
export interface JudgingRuleWhen {
  /** Runs of these agents (their own runs, not their turns as a flow's step). */
  readonly agentIds?: readonly string[];
  /** Runs of these flows. */
  readonly flowIds?: readonly string[];
  /** These versions exactly, or `live`: the agent ran the version live for the run's scope. */
  readonly versions?: readonly string[];
  /** How the run ended. Absent: `completed` and `failed`. */
  readonly status?: readonly JudgingRunStatus[];
  /** Dry runs are left out unless this is `true`. Replays never match. */
  readonly includeDryRuns?: boolean;
}

/** What a rule is, as a caller writes it. */
export interface JudgingRuleSpec {
  readonly name: string;
  readonly when: JudgingRuleWhen;
  /** The share of matching runs queued, 0 < sample ≤ 1. Decided by the run and rule ids, the same every time. Default 1. */
  readonly sample?: number;
  /** Add nothing while this rule has this many open items. Absent: no cap. */
  readonly maxOpen?: number;
  /** Whose judgment the rule wants: a judgment of this class closes it. Absent: any judgment does. */
  readonly judgeClassId?: string;
  /** Default `true`. */
  readonly enabled?: boolean;
}

/** One version of a rule. */
export interface JudgingRule {
  readonly ruleId: string;
  readonly projectId: string;
  readonly version: number;
  readonly name: string;
  readonly when: JudgingRuleWhen;
  readonly sample: number;
  readonly maxOpen?: number;
  readonly judgeClassId?: string;
  readonly enabled: boolean;
  /** Who wrote this version (a principal reference), when known. */
  readonly createdBy?: string;
  readonly createdAt: Timestamp;
  /** Set when the rule was unregistered. */
  readonly unregisteredAt?: Timestamp;
}

/** Where a queued run stands. `erased`: its content was erased; the item shows nothing of it. */
export type JudgingQueueState = 'open' | 'judged' | 'dismissed' | 'erased';

/** One queued run: never its content, only what it was and where it stands. */
export interface JudgingQueueItem {
  readonly runId: string;
  readonly projectId: string;
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly flowId: string;
  readonly runStatus: JudgingRunStatus;
  readonly completedAt: Timestamp;
  /** The rules it matched. */
  readonly ruleIds: readonly string[];
  /** The judge classes its rules want; `anyJudgment` when one of them wants any judgment. */
  readonly wantedClassIds: readonly string[];
  readonly anyJudgment: boolean;
  /** The live judgments on the run so far, by class (`null`: unclassified). */
  readonly progress: {
    readonly total: number;
    readonly byClass: readonly { readonly judgeClassId: string | null; readonly count: number }[];
  };
  readonly addedAt: Timestamp;
  readonly state: JudgingQueueState;
  readonly closedAt?: Timestamp;
  /** Who dismissed or reopened it last (a principal reference). */
  readonly closedBy?: string;
  readonly reason?: string;
}

/** A rule's results since a time, by agent version: never pooled with another rule's. */
export interface JudgingRuleResults {
  readonly ruleId: string;
  readonly since?: Timestamp;
  readonly versions: readonly {
    /** `null`: a flow run, or a run from before versions were recorded. */
    readonly agentVersion: string | null;
    readonly added: number;
    readonly judged: number;
    readonly dismissed: number;
    readonly open: number;
    /** Live judgments on those runs. */
    readonly judgments: number;
    /** Their `yes` share, each weighted by its class (unclassified: 1). `null` with no judgments. */
    readonly yesShare: number | null;
  }[];
}

/** What a rule would have queued among a project's recent runs. */
export interface JudgingRulePreview {
  /** The recent runs looked at (top-level, not replays), newest first. */
  readonly considered: number;
  /** Of those, the ones the rule (with its sample) would have queued. */
  readonly matched: number;
  /** Of the matched, the ones that failed. */
  readonly failed: number;
}

export type JudgingErrorCode =
  | 'judging-rule-not-found'
  | 'judging-item-not-found'
  /** Dismissing an item that isn't open, or reopening one that wasn't dismissed. */
  | 'judging-item-not-open'
  | 'judge-class-not-found';

export interface JudgingError {
  readonly code: JudgingErrorCode;
  readonly message: string;
}

interface InProject {
  readonly tenantId: TenantId;
  readonly projectId: string;
}

export interface JudgingQueueListInput extends InProject {
  readonly state?: JudgingQueueState;
  readonly agentId?: string;
  readonly ruleId?: string;
  readonly judgeClassId?: string;
  /** Only items any judgment closes, or that want one of these classes (the caller's `forMe`). */
  readonly wantedFrom?: readonly string[];
  readonly addedAfter?: Timestamp;
  readonly closedAfter?: Timestamp;
  /** 0: only the `total`. */
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface JudgingQueuePage {
  readonly data: readonly JudgingQueueItem[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
  /** Every item the filters match, across pages. */
  readonly total: number;
}

export interface JudgingRulePage {
  readonly data: readonly JudgingRule[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface JudgingQueueBinding {
  createRule(
    input: InProject & { readonly spec: JudgingRuleSpec; readonly by?: string },
  ): Promise<Result<JudgingRule, JudgingError>>;
  /** A new version with `patch` applied to the latest. */
  updateRule(
    input: InProject & {
      readonly ruleId: string;
      readonly patch: Partial<JudgingRuleSpec>;
      readonly by?: string;
    },
  ): Promise<Result<JudgingRule, JudgingError>>;
  /** `false` when unknown or already unregistered. */
  unregisterRule(
    input: InProject & { readonly ruleId: string; readonly by?: string },
  ): Promise<{ readonly unregistered: boolean }>;
  /** The latest version, or `null` when unknown (`includeUnregistered` for a retired one). */
  getRule(
    input: InProject & { readonly ruleId: string; readonly includeUnregistered?: boolean },
  ): Promise<JudgingRule | null>;
  /** Live rules (their latest versions), oldest first. */
  listRules(
    input: InProject & { readonly limit: number; readonly cursor?: Cursor },
  ): Promise<JudgingRulePage>;
  /** Every version of a rule, newest first. */
  ruleVersions(
    input: InProject & {
      readonly ruleId: string;
      readonly limit: number;
      readonly cursor?: Cursor;
    },
  ): Promise<JudgingRulePage>;
  /** Queued runs, oldest first. */
  listQueue(input: JudgingQueueListInput): Promise<JudgingQueuePage>;
  dismiss(
    input: InProject & { readonly runId: string; readonly by?: string; readonly reason?: string },
  ): Promise<Result<JudgingQueueItem, JudgingError>>;
  reopen(
    input: InProject & { readonly runId: string; readonly by?: string },
  ): Promise<Result<JudgingQueueItem, JudgingError>>;
  results(
    input: InProject & { readonly ruleId: string; readonly since?: Timestamp },
  ): Promise<Result<JudgingRuleResults, JudgingError>>;
  /** What `spec` would have queued among the project's last `last` runs. */
  preview(
    input: InProject & { readonly spec: JudgingRuleSpec; readonly last: number },
  ): Promise<JudgingRulePreview>;
}
