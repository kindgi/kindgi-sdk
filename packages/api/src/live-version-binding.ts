// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  Cursor,
  LiveScope,
  OrgId,
  ProjectId,
  Result,
  ScopeSegment,
  Semver,
  TenantId,
  Timestamp,
} from '@kindgi/types';

/**
 * Live versions of agents: which version serves a scope, and the
 * promotions that put it there (evals step 4). A run that names no
 * version takes the most specific live version that covers it (a
 * segment path, then its project, its org, the tenant), else the latest
 * registered one, as before anything is pinned.
 */

/** What a run's version is resolved for: its project (and org) and its segment path. */
export interface LiveResolveInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  /** Absent → only the org's pin (with `orgId`) and the tenant-wide pin apply. */
  readonly projectId?: ProjectId;
  /**
   * The project's org, when it has one (the resolver may look it up from
   * `projectId` itself). Without `projectId`: an org scope's own
   * coordinates, as the promotion gate resolves what serves an org.
   */
  readonly orgId?: OrgId;
  /** Coarse to fine (needs `projectId`); a segment pin covers every path that starts with its own. */
  readonly segments?: readonly ScopeSegment[];
}

export interface LiveResolution {
  readonly version: Semver;
  /** The pin that matched. */
  readonly scope: LiveScope;
}

export interface LivePin {
  readonly agentId: string;
  readonly scope: LiveScope;
  readonly version: Semver;
  /** The promotion that set it. */
  readonly promotionId: string;
  readonly setAt: Timestamp;
}

export interface LiveVersionBinding {
  /** The most specific live version covering the input; `null` when none is pinned on the way up. */
  resolve(input: LiveResolveInput): Promise<LiveResolution | null>;
  /** Every pin of an agent. */
  list(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<
    readonly LivePin[]
  >;
}

/** Who asked: the request's principal (a user, or a service token). */
export interface PromotionActor {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

export type PromotionAction = 'promote' | 'rollback' | 'unpin';

/**
 * One change of a scope's live version, kept for good (the audit trail):
 * what was live before, what is after, who asked and why.
 */
export interface Promotion {
  readonly id: string;
  readonly agentId: string;
  readonly scope: LiveScope;
  readonly action: PromotionAction;
  /** The scope's own pin before; `null` when it had none. */
  readonly fromVersion: Semver | null;
  /** The scope's own pin after; `null` after an unpin. */
  readonly toVersion: Semver | null;
  readonly requestedBy: PromotionActor;
  readonly reason?: string;
  /** The comparison the change was judged on, when there was one. */
  readonly evalRunId?: string;
  readonly createdAt: Timestamp;
}

export type PromotionErrorCode =
  /** The version isn't registered for this agent, or was unregistered. */
  | 'agent-version-not-found'
  /** The scope names an org or project the tenant doesn't have. */
  | 'scope-invalid'
  /** Rollback: the scope has no earlier live version to go back to. */
  | 'nothing-to-roll-back'
  /** Unpin or rollback: the scope has no pin of its own. */
  | 'not-pinned'
  | 'persistence-error';

export interface PromotionError {
  readonly code: PromotionErrorCode;
  readonly message: string;
}

export interface PromoteInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly version: Semver;
  readonly scope: LiveScope;
  readonly requestedBy: PromotionActor;
  readonly reason?: string;
  readonly evalRunId?: string;
}

export interface RollbackInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly scope: LiveScope;
  /** Back to this earlier version; absent → the scope's previous live version. */
  readonly toVersion?: Semver;
  readonly requestedBy: PromotionActor;
  readonly reason?: string;
}

export interface UnpinInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly scope: LiveScope;
  readonly requestedBy: PromotionActor;
  readonly reason?: string;
}

export interface ListPromotionsInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  /** Only this scope's history. */
  readonly scope?: LiveScope;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface PromotionBinding {
  /** Make `version` live for `scope`. The version must be registered and active. */
  promote(input: PromoteInput): Promise<Result<Promotion, PromotionError>>;
  /** Back to the scope's previous live version, or a named earlier one. */
  rollback(input: RollbackInput): Promise<Result<Promotion, PromotionError>>;
  /** Remove the scope's own pin: it falls back to the next scope up. */
  unpin(input: UnpinInput): Promise<Result<Promotion, PromotionError>>;
  list(input: ListPromotionsInput): Promise<{
    readonly data: readonly Promotion[];
    readonly nextCursor?: Cursor;
  }>;
  get(tenantId: TenantId, promotionId: string): Promise<Promotion | null>;
}

/** The bindings behind an agent's live versions and promotions (`createApp({ agentReleases })`). */
export interface AgentReleaseBindings {
  readonly live: LiveVersionBinding;
  readonly promotions: PromotionBinding;
}
