// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AgentPinScope,
  Cursor,
  OrgId,
  ProjectId,
  Result,
  ScopeSegment,
  Semver,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import type { GateApproval, GateCheck } from './gate.js';
import type { LatestBinding } from './latest-binding.js';
import type { ReleaseGateBinding, ReleaseGateRef } from './release-gate-binding.js';

/**
 * Pinned versions of agents: which version serves a scope, and the
 * pin changes that put it there. A run that names no
 * version takes the most specific pinned version that covers it (a
 * segment path, then its project, its org, the tenant), else Latest
 * (`LatestBinding`): `whatRuns`.
 */

/** What a run's version is resolved for: its project (and org) and its segment path. */
export interface AgentPinResolveInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  /** Absent → only the org's pin (with `orgId`) and the tenant-wide pin apply. */
  readonly projectId?: ProjectId;
  /**
   * The project's org, when it has one (the resolver may look it up from
   * `projectId` itself). Without `projectId`: an org scope's own
   * coordinates, as the pin gate resolves what serves an org.
   */
  readonly orgId?: OrgId;
  /** Coarse to fine (needs `projectId`); a segment pin covers every path that starts with its own. */
  readonly segments?: readonly ScopeSegment[];
}

export interface AgentPinResolution {
  readonly version: Semver;
  /** The pin that matched. */
  readonly scope: AgentPinScope;
}

export interface AgentPinnedVersion {
  readonly agentId: string;
  readonly scope: AgentPinScope;
  readonly version: Semver;
  /** The pin change that set it. */
  readonly changeId: string;
  readonly setAt: Timestamp;
}

export interface AgentPinnedVersionBinding {
  /** The most specific pinned version covering the input; `null` when none is pinned on the way up. */
  resolve(input: AgentPinResolveInput): Promise<AgentPinResolution | null>;
  /** Every pin of an agent. */
  list(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<
    readonly AgentPinnedVersion[]
  >;
  /**
   * A page of every agent's pins that cover a project: the tenant's, the
   * project's org's (the binding finds the org itself, as `resolve` may),
   * the project's own and its segments', ordered by agent id, then scope.
   * Optional: without it, `GET /v1/projects/:projectId/pinned-versions`
   * answers `501 pinned-versions-not-supported`.
   */
  listCovering?(input: ListCoveringPinsInput): Promise<{
    readonly data: readonly AgentPinnedVersion[];
    readonly nextCursor?: Cursor;
  }>;
  /**
   * Whether `cursor` is one this binding issued for `listCovering`
   * (`'covering'`: a page's `nextCursor`), as `PinBinding.issuedCursor`
   * is for its `list`. Optional: without it, the route passes any cursor on.
   */
  issuedCursor?(list: 'covering', cursor: Cursor): boolean;
}

/** A page of the pins that cover one project (`AgentPinnedVersionBinding.listCovering`). */
export interface ListCoveringPinsInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly limit: number;
  readonly cursor?: Cursor;
}

/** Who asked: the request's principal (a user, or a service token). */
export interface PinActor {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

export type PinAction = 'pin' | 'unpin';

/**
 * Where a pin request stands. Only `pin` rows have one; an unpin is
 * immediate. A request's status changes once, from `pending-approval` to
 * its final state.
 */
export type PinStatus =
  /** The version is pinned for the scope. */
  | 'pinned'
  /** The gate passed; a reviewer's approval is open. The pinned version is unchanged. */
  | 'pending-approval'
  /** The gate failed (`checks` say why). The pinned version is unchanged. */
  | 'refused'
  /** Approved, but the scope's pinned version or release gate changed meanwhile: check again. */
  | 'superseded'
  /** The reviewer rejected it. */
  | 'rejected'
  /** The approval expired undecided. */
  | 'expired';

/**
 * One change of a scope's pinned version, kept for good (the audit trail):
 * what was pinned before, what is after, who asked and why.
 */
export interface Pin {
  readonly id: string;
  readonly agentId: string;
  readonly scope: AgentPinScope;
  readonly action: PinAction;
  /** The scope's own pin before; `null` when it had none. */
  readonly fromVersion: Semver | null;
  /** The scope's own pin after; `null` after an unpin. */
  readonly toVersion: Semver | null;
  /**
   * A `pin`'s: what ran in the scope just before it (the gate's
   * `servingVersion`), from a pin or from Latest. A pin of an earlier
   * version than it is going back. Absent on an unpin, and on a pin
   * recorded before it was kept.
   */
  readonly ranBefore?: Semver;
  readonly requestedBy: PinActor;
  readonly reason?: string;
  /** The comparison behind the change, when there was one. */
  readonly testRunId?: string;
  readonly createdAt: Timestamp;
  /** A `pin` row's state; absent on a pin made before gates (`pinned`). */
  readonly status?: PinStatus;
  /** The release gate that applied; `null` when none did. Absent before gates. */
  readonly releaseGate?: ReleaseGateRef | null;
  /** The gate's checks, as they ran. */
  readonly checks?: readonly GateCheck[];
  /** The approval a `pending-approval` pin waits on (kept once decided). */
  readonly approvalId?: string;
  /** When a `pending-approval` pin reached its final state. */
  readonly resolvedAt?: Timestamp;
  /**
   * A `pin`'s: `true` when it took a project that followed Latest off
   * it (`AgentPinInput.stoppedFollowingLatest`). Absent otherwise, and on
   * a pin recorded before it was kept.
   */
  readonly stoppedFollowingLatest?: boolean;
}

export type PinErrorCode =
  /** The version isn't registered for this agent, or was unregistered. */
  | 'agent-version-not-found'
  /** The scope names an org or project the tenant doesn't have. */
  | 'scope-invalid'
  /**
   * A pin: no version of the agent runs in the scope yet (no pin covers
   * it, and it has no Latest), so there's nothing to measure the version
   * against. A deploy or a person's publish into it comes first.
   */
  | 'nothing-runs-in-scope'
  /**
   * A pin where nothing runs because the scope's project is suspended
   * (its deployments are retired). Nothing is pinned until it's restored.
   */
  | 'project-suspended'
  /** Unpin: the scope has no pin of its own. */
  | 'not-pinned'
  /** The scope's pinned version changed while the gate ran: check again. */
  | 'pin-superseded'
  /**
   * Unpin: the scope has a release gate of its own, and a gated scope keeps
   * its own pin (else a change above it, or a publish, would reach it
   * ungated). Unregister the release gate first, or pin an earlier version instead.
   */
  | 'release-gate-needs-pin'
  /**
   * Pin or unpin: the change would also move a narrower
   * scope a release gate applies to, which has no pin of its own and so
   * follows this scope, without its gate. The message names each such
   * scope: pin it at its current version first. (A gated scope must hold
   * its own pin; this guards scopes gated before that rule.)
   */
  | 'release-gate-descendant-unpinned'
  /**
   * Pin: the gate wants an approval, and the tenant's approvals waiting
   * for a decision are at its limit (the runtime's operator sets it).
   * Nothing is recorded.
   */
  | 'approvals-pending-limit'
  /**
   * A registry that takes Improve's candidates (`RegistryReadOnly.takesCandidates`,
   * `kindgi dev`): pinning a version writes it into the pack's files,
   * which serve every scope, so a narrower scope is refused; and a pin of
   * an earlier version or an unpin is undone there, with git. The message
   * says which.
   */
  | 'registry-read-only'
  | 'persistence-error';

export interface PinError {
  readonly code: PinErrorCode;
  readonly message: string;
}

export interface AgentPinInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly version: Semver;
  readonly scope: AgentPinScope;
  readonly requestedBy: PinActor;
  readonly reason?: string;
  readonly testRunId?: string;
  /**
   * The pin takes a project that follows Latest off it, as the caller
   * asked (`requestPin`'s `stopFollowingLatest`): kept on the change
   * (`Pin.stoppedFollowingLatest`). Absent otherwise.
   */
  readonly stoppedFollowingLatest?: boolean;
}

/**
 * A pin with the gate's verdict, recorded as one request: refused,
 * waiting for approval, or pinned. The route runs the gate; the
 * binding records the outcome atomically.
 */
export interface PinRequestInput extends AgentPinInput {
  readonly gate: {
    readonly releaseGate: ReleaseGateRef | null;
    readonly checks: readonly GateCheck[];
    readonly passed: boolean;
    /** A passing pin waits for this approval instead of taking effect. */
    readonly approval?: GateApproval;
    /**
     * What served the scope when the gate ran. A binding refuses with
     * `pin-superseded` when it no longer does, and an approved
     * pin whose scope moved on becomes `superseded`.
     */
    readonly servingVersion: Semver;
    /**
     * A pin in place: the scope has no pin of its own and serves exactly
     * the pinned version (`servingVersion`), so pinning it there changes
     * nothing any run gets. The gate's checks and approval don't apply:
     * `checks` holds one passing `pinInPlace` line and there's no
     * `approval`. The binding re-checks both conditions in the write's
     * transaction, under the scope's lock, and refuses with
     * `pin-superseded` when either no longer holds; it records the
     * pin `pinned`, with the release gate, its reason starting
     * `pin-in-place`.
     */
    readonly pinInPlace?: boolean;
  };
}

export interface AgentUnpinInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly scope: AgentPinScope;
  readonly requestedBy: PinActor;
  readonly reason?: string;
}

export interface ListPinHistoryInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  /** Only this scope's history. */
  readonly scope?: AgentPinScope;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface PinBinding {
  /**
   * Pin `version` for `scope`. The version must be registered and
   * active. `release-gate-descendant-unpinned` when it would also move a
   * narrower gated scope with no pin of its own.
   */
  pin(input: AgentPinInput): Promise<Result<Pin, PinError>>;
  /**
   * Record a gated pin request: `refused` when the
   * gate failed, `pending-approval` (opening a HITL approval, subject
   * `agent-pin`) when it passed and the gate wants an approval,
   * else `pinned`. Optional: without it, the route refuses a pin
   * a release gate applies to (`501`), rather than pinning ungated. A
   * passing request that would also move a narrower gated scope with no
   * pin of its own is `release-gate-descendant-unpinned`, and so is its
   * approval's apply (the pin is then `superseded`).
   */
  request?(input: PinRequestInput): Promise<Result<Pin, PinError>>;
  /**
   * Remove the scope's own pin: it falls back to the next scope up. With
   * release gates, `release-gate-needs-pin` when the scope has a release
   * gate of its own, and `release-gate-descendant-unpinned` when a
   * narrower gated scope with no pin of its own follows it.
   */
  unpin(input: AgentUnpinInput): Promise<Result<Pin, PinError>>;
  list(input: ListPinHistoryInput): Promise<{
    readonly data: readonly Pin[];
    readonly nextCursor?: Cursor;
  }>;
  /**
   * Whether `cursor` is one this binding issued for `list` (`'pin-history'`:
   * a `list` page's `nextCursor`). Optional: without it, the route passes any
   * cursor to the list, as before. With it, a cursor the binding didn't
   * issue answers `400 bad-input` before the list is read, so a client
   * paging until done is never sent back to the first page.
   */
  issuedCursor?(list: 'pin-history', cursor: Cursor): boolean;
  get(tenantId: TenantId, changeId: string): Promise<Pin | null>;
}

/** The bindings behind an agent's pinned versions and pin changes (`createApp({ agentPins })`). */
export interface AgentPinBindings {
  readonly pinned: AgentPinnedVersionBinding;
  /** What a scope no pin covers runs: Latest (`whatRuns`). */
  readonly latest: LatestBinding;
  readonly changes: PinBinding;
  /** Release gates. Absent: no gates, every pin goes through as before. */
  readonly releaseGates?: ReleaseGateBinding;
}
