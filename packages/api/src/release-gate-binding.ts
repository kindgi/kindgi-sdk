// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerRole } from '@kindgi/authz';
import type { AgentPinScope, Cursor, Result, TenantId, Timestamp } from '@kindgi/types';

/**
 * Release gates: what an agent version must show before it is pinned for
 * a scope. One gate per agent and scope; the most specific one covering a
 * pin's scope applies, at its latest active version. The same registry
 * shape as retention policies: the caller names the gate and its semver
 * versions.
 */

/** The metrics a release gate can check, from a comparison's summary. */
export const GATE_METRICS = ['passRate', 'caseCoverage', 'weightedPrecisionAtK'] as const;
export type GateMetricName = (typeof GATE_METRICS)[number];

export interface GateMetricSpec {
  readonly name: GateMetricName;
  /** `weightedPrecisionAtK` only: the summary's `k` must be this. */
  readonly k?: number;
  /** The candidate must reach this. */
  readonly minCandidate?: number;
  /** The candidate may fall at most this far below the baseline (`0`: no drop at all). */
  readonly maxDrop?: number;
}

/**
 * What a release gate asks of a pin. Every part is optional; an empty
 * spec checks nothing (the pin is still recorded with the gate). A pin
 * must name a comparison (`testRunId`) exactly when the spec
 * checks anything one shows: `comparison`, `evidence`, `metrics`,
 * `replay`, `cases` or `onlyExpertGroups`.
 */
export interface ReleaseGateSpec {
  readonly comparison?: {
    /** The comparison must have finished within this many hours. */
    readonly maxAgeHours?: number;
    /** The comparison must have run this test set (and version). */
    readonly testSet?: { readonly id: string; readonly version?: string };
  };
  /** The evidence from corrections behind each gated metric (`n` cases, total weight). */
  readonly evidence?: { readonly minCases?: number; readonly minWeight?: number };
  readonly metrics?: readonly GateMetricSpec[];
  /** Replay counts; each knob left out of the block is 0. No block: no replay checks. */
  readonly replay?: {
    readonly maxDiverged?: number;
    readonly maxErrors?: number;
    readonly maxRefusedWrites?: number;
    readonly maxStopped?: number;
  };
  /**
   * The cases the comparison graded: each correction it checked is a
   * case, and it passes when every repetition did.
   */
  readonly cases?: {
    /** At least this many cases pass. */
    readonly minPassing?: number;
    /**
     * No case that passed before fails: none of the comparison's
     * corrections that are `fixed` now fails it. One the comparison
     * didn't grade isn't counted.
     */
    readonly noNewFailures?: boolean;
  };
  /** A passing pin waits for a reviewer's approval. */
  readonly approvals?: {
    /** The reviewer role it needs (default `senior`). */
    readonly role?: ReviewerRole;
    /** Whoever asked can't approve it (default `true`). */
    readonly separateApprover?: boolean;
  };
  /**
   * Only corrections recorded under an expert group count (T200):
   * the comparison must be weighted `experts-only`, so a group anyone
   * may assert can't move the gate.
   */
  readonly onlyExpertGroups?: boolean;
}

export interface ReleaseGate {
  readonly id: string;
  readonly version: string;
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly scope: AgentPinScope;
  readonly spec: ReleaseGateSpec;
  readonly description?: string;
  readonly createdAt: Timestamp;
  /** Set when this version was unregistered. */
  readonly unregisteredAt?: Timestamp;
}

/** A release gate version, as a pin records which one gated it. */
export interface ReleaseGateRef {
  readonly id: string;
  readonly version: string;
}

export interface ReleaseGatePublishInput {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly version: string;
  readonly agentId: string;
  readonly scope: AgentPinScope;
  readonly spec: ReleaseGateSpec;
  readonly description?: string;
}

export type ReleaseGateErrorCode =
  /** This id and version are registered already. */
  | 'release-gate-already-registered'
  /** Another release gate already gates this agent and scope. */
  | 'release-gate-scope-taken'
  /** A new version names another agent or scope than the gate's. */
  | 'release-gate-scope-changed'
  /**
   * The scope has no pinned version of its own. A gated scope holds its own
   * pin: following the latest version, a publish would take effect there
   * ungated; following a pin above it, a pin up there would. Pin a version
   * for the scope first.
   */
  | 'release-gate-scope-unpinned'
  | 'release-gate-not-found'
  /** The scope names an org or project the tenant doesn't have. */
  | 'scope-invalid'
  | 'persistence-error';

export interface ReleaseGateError {
  readonly code: ReleaseGateErrorCode;
  readonly message: string;
  /** `release-gate-scope-taken`: the gate that holds the scope. */
  readonly heldBy?: string;
}

export interface ReleaseGateListInput {
  readonly tenantId: TenantId;
  readonly agentId?: string;
  /** Only the gate of exactly this scope. */
  readonly scope?: AgentPinScope;
  readonly limit: number;
  readonly cursor?: Cursor;
  /**
   * `true` lists retired gates too (every version unregistered), each
   * as its highest version, with that version's `unregisteredAt`, so a
   * client can find one to reinstate. Default: gates with an active
   * version only.
   */
  readonly includeRetired?: boolean;
}

export interface ReleaseGateVersionInput {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly version: string;
}

export interface ReleaseGateBinding {
  /**
   * Register `id` at `version`: a new gate, or a new version of one
   * (same agent and scope). A gated scope holds its own pin:
   * `release-gate-scope-unpinned` when the scope has none (a pin above it
   * isn't enough). Reinstating a version checks the same.
   */
  publish(input: ReleaseGatePublishInput): Promise<Result<ReleaseGate, ReleaseGateError>>;
  /** The gate's latest active version, or `null`. */
  get(input: { readonly tenantId: TenantId; readonly id: string }): Promise<ReleaseGate | null>;
  /** One version, unregistered ones too, or `null`. */
  getVersion(input: ReleaseGateVersionInput): Promise<ReleaseGate | null>;
  /** Every version of a gate, oldest first. */
  listVersions(input: {
    readonly tenantId: TenantId;
    readonly id: string;
  }): Promise<readonly ReleaseGate[]>;
  /**
   * Each gate's latest active version. With `includeRetired`, a retired
   * gate (every version unregistered) too, as its highest version with
   * `unregisteredAt`.
   */
  list(input: ReleaseGateListInput): Promise<{
    readonly data: readonly ReleaseGate[];
    readonly nextCursor?: Cursor;
  }>;
  unregister(input: ReleaseGateVersionInput): Promise<Result<ReleaseGate, ReleaseGateError>>;
  reinstate(input: ReleaseGateVersionInput): Promise<Result<ReleaseGate, ReleaseGateError>>;
  /**
   * The release gate that checks a pin of `agentId` for `scope`: the most
   * specific scope with an active gate (a segment path's longer prefixes
   * first, then its project, the project's org, the tenant), at its latest
   * active version. `null`: no gate.
   */
  resolve(input: {
    readonly tenantId: TenantId;
    readonly agentId: string;
    readonly scope: AgentPinScope;
  }): Promise<ReleaseGate | null>;
}
