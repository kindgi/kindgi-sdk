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

import type { GatePolicyBinding, GatePolicyRef } from './gate-policy-binding.js';
import type { GateApproval, GateCheck } from './gate.js';

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
 * Where a promotion request stands. Only `promote` rows have one; rollback
 * and unpin are immediate. A request's status changes once, from
 * `pending-approval` to its final state.
 */
export type PromotionStatus =
  /** The version is live for the scope. */
  | 'promoted'
  /** The gate passed; a reviewer's approval is open. The live version is unchanged. */
  | 'pending-approval'
  /** The gate failed (`checks` say why). The live version is unchanged. */
  | 'refused'
  /** Approved, but the scope's live version or policy changed meanwhile: check again. */
  | 'superseded'
  /** The reviewer rejected it. */
  | 'rejected'
  /** The approval expired undecided. */
  | 'expired';

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
  /** A `promote` row's state; absent on a promotion made before gates (`promoted`). */
  readonly status?: PromotionStatus;
  /** The gate policy that applied; `null` when none did. Absent before gates. */
  readonly policy?: GatePolicyRef | null;
  /** The gate's checks, as they ran. */
  readonly checks?: readonly GateCheck[];
  /** The approval a `pending-approval` promotion waits on (kept once decided). */
  readonly approvalId?: string;
  /** When a `pending-approval` promotion reached its final state. */
  readonly resolvedAt?: Timestamp;
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
  /** The scope's live version changed while the gate ran: check again. */
  | 'promotion-superseded'
  /**
   * Unpin: the scope has a gate policy of its own, and a gated scope keeps
   * its own pin (else a change above it, or a publish, would reach it
   * ungated). Unregister the gate policy first, or roll back instead.
   */
  | 'gate-policy-needs-pin'
  /**
   * Promote, rollback or unpin: the change would also move a narrower
   * scope a gate policy applies to, which has no pin of its own and so
   * follows this scope, without its gate. The message names each such
   * scope: pin it at its current version first. (A gated scope must hold
   * its own pin; this guards scopes gated before that rule.)
   */
  | 'gate-policy-descendant-unpinned'
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

/**
 * A promotion with the gate's verdict, recorded as one request: refused,
 * waiting for approval, or promoted. The route runs the gate; the
 * binding records the outcome atomically.
 */
export interface PromotionRequestInput extends PromoteInput {
  readonly gate: {
    readonly policy: GatePolicyRef | null;
    readonly checks: readonly GateCheck[];
    readonly passed: boolean;
    /** A passing promotion waits for this approval instead of going live. */
    readonly approval?: GateApproval;
    /**
     * What served the scope when the gate ran. A binding refuses with
     * `promotion-superseded` when it no longer does, and an approved
     * promotion whose scope moved on becomes `superseded`.
     */
    readonly servingVersion: Semver;
    /**
     * A pin in place: the scope has no pin of its own and serves exactly
     * the promoted version (`servingVersion`), so pinning it there changes
     * nothing any run gets. The gate's checks and approval don't apply:
     * `checks` holds one passing `pinInPlace` line and there's no
     * `approval`. The binding re-checks both conditions in the write's
     * transaction, under the scope's lock, and refuses with
     * `promotion-superseded` when either no longer holds; it records the
     * promotion `promoted`, with the policy, its reason starting
     * `pin-in-place`.
     */
    readonly pinInPlace?: boolean;
  };
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
  /**
   * Make `version` live for `scope`. The version must be registered and
   * active. `gate-policy-descendant-unpinned` when it would also move a
   * narrower gated scope with no pin of its own.
   */
  promote(input: PromoteInput): Promise<Result<Promotion, PromotionError>>;
  /**
   * Record a gated promotion request (evals step 4b): `refused` when the
   * gate failed, `pending-approval` (opening a HITL approval, subject
   * `agent-promotion`) when it passed and the policy wants an approval,
   * else `promoted`. Optional: without it, the route refuses a promotion
   * a gate policy applies to (`501`), rather than promoting ungated. A
   * passing request that would also move a narrower gated scope with no
   * pin of its own is `gate-policy-descendant-unpinned`, and so is its
   * approval's apply (the promotion is then `superseded`).
   */
  request?(input: PromotionRequestInput): Promise<Result<Promotion, PromotionError>>;
  /**
   * Back to the scope's previous live version, or a named earlier one,
   * at once (no gate). `gate-policy-descendant-unpinned` as for `promote`.
   */
  rollback(input: RollbackInput): Promise<Result<Promotion, PromotionError>>;
  /**
   * Remove the scope's own pin: it falls back to the next scope up. With
   * gate policies, `gate-policy-needs-pin` when the scope has a gate
   * policy of its own, and `gate-policy-descendant-unpinned` when a
   * narrower gated scope with no pin of its own follows it.
   */
  unpin(input: UnpinInput): Promise<Result<Promotion, PromotionError>>;
  list(input: ListPromotionsInput): Promise<{
    readonly data: readonly Promotion[];
    readonly nextCursor?: Cursor;
  }>;
  /**
   * Whether `cursor` is one this binding issued for `list` (`'promotions'`:
   * a `list` page's `nextCursor`). Optional: without it, the route passes any
   * cursor to the list, as before. With it, a cursor the binding didn't
   * issue answers `400 bad-input` before the list is read, so a client
   * paging until done is never sent back to the first page.
   */
  issuedCursor?(list: 'promotions', cursor: Cursor): boolean;
  get(tenantId: TenantId, promotionId: string): Promise<Promotion | null>;
}

/** The bindings behind an agent's live versions and promotions (`createApp({ agentReleases })`). */
export interface AgentReleaseBindings {
  readonly live: LiveVersionBinding;
  readonly promotions: PromotionBinding;
  /** Gate policies (evals step 4b). Absent: no gates, every promotion goes through as before. */
  readonly gatePolicies?: GatePolicyBinding;
}
