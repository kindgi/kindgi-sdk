// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerRole } from '@kindgi/authz';
import type { Cursor, LiveScope, Result, TenantId, Timestamp } from '@kindgi/types';

/**
 * Gate policies (evals step 4b): what a promotion of an agent must show
 * before a version goes live for a scope. One policy per agent and scope;
 * the most specific one covering a promotion's scope applies, at its
 * latest active version. The same registry shape as retention policies:
 * the caller names the policy and its semver versions.
 */

/** The metrics a policy can gate, from a comparison's summary. */
export const GATE_METRICS = ['weightedYesShare', 'judgedCoverage', 'weightedPrecisionAtK'] as const;
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
 * What a policy asks of a promotion. Every part is optional; an empty
 * spec checks nothing (the promotion is still recorded with the policy).
 * A promotion must name a comparison (`evalRunId`) exactly when the spec
 * checks anything one shows: `comparison`, `evidence`, `metrics` or
 * `replay`.
 */
export interface GatePolicySpec {
  readonly comparison?: {
    /** The comparison must have finished within this many hours. */
    readonly maxAgeHours?: number;
    /** The comparison must have run this test set (and version). */
    readonly suite?: { readonly id: string; readonly version?: string };
  };
  /** The judged evidence behind each gated metric (`n` cases, total weight). */
  readonly evidence?: { readonly minCases?: number; readonly minWeight?: number };
  readonly metrics?: readonly GateMetricSpec[];
  /** Replay counts; each knob left out of the block is 0. No block: no replay checks. */
  readonly replay?: {
    readonly maxDiverged?: number;
    readonly maxErrors?: number;
    readonly maxRefusedWrites?: number;
    readonly maxStopped?: number;
  };
  /** A passing promotion waits for a reviewer's approval. */
  readonly approvals?: {
    /** The reviewer role it needs (default `senior`). */
    readonly role?: ReviewerRole;
    /** Whoever asked can't approve it (default `true`). */
    readonly separateApprover?: boolean;
  };
}

export interface GatePolicy {
  readonly id: string;
  readonly version: string;
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly scope: LiveScope;
  readonly spec: GatePolicySpec;
  readonly description?: string;
  readonly createdAt: Timestamp;
  /** Set when this version was unregistered. */
  readonly unregisteredAt?: Timestamp;
}

/** A policy version, as a promotion records which one gated it. */
export interface GatePolicyRef {
  readonly id: string;
  readonly version: string;
}

export interface GatePolicyPublishInput {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly version: string;
  readonly agentId: string;
  readonly scope: LiveScope;
  readonly spec: GatePolicySpec;
  readonly description?: string;
}

export type GatePolicyErrorCode =
  /** This id and version are registered already. */
  | 'gate-policy-already-registered'
  /** Another policy already gates this agent and scope. */
  | 'gate-policy-scope-taken'
  /** A new version names another agent or scope than the policy's. */
  | 'gate-policy-scope-changed'
  /**
   * The scope resolves to the agent's latest version (no pin covers it),
   * so publishing a version would make it live there ungated: pin a
   * version for the scope, or one above it, first.
   */
  | 'gate-policy-scope-unpinned'
  | 'gate-policy-not-found'
  /** The scope names an org or project the tenant doesn't have. */
  | 'scope-invalid'
  | 'persistence-error';

export interface GatePolicyError {
  readonly code: GatePolicyErrorCode;
  readonly message: string;
  /** `gate-policy-scope-taken`: the policy that holds the scope. */
  readonly heldBy?: string;
}

export interface GatePolicyListInput {
  readonly tenantId: TenantId;
  readonly agentId?: string;
  /** Only the policy of exactly this scope. */
  readonly scope?: LiveScope;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface GatePolicyVersionInput {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly version: string;
}

export interface GatePolicyBinding {
  /**
   * Register `id` at `version`: a new policy, or a new version of one
   * (same agent and scope). A gated scope always resolves to a pin:
   * `gate-policy-scope-unpinned` when nothing covering the scope is pinned.
   */
  publish(input: GatePolicyPublishInput): Promise<Result<GatePolicy, GatePolicyError>>;
  /** The policy's latest active version, or `null`. */
  get(input: { readonly tenantId: TenantId; readonly id: string }): Promise<GatePolicy | null>;
  /** One version, unregistered ones too, or `null`. */
  getVersion(input: GatePolicyVersionInput): Promise<GatePolicy | null>;
  /** Every version of a policy, oldest first. */
  listVersions(input: {
    readonly tenantId: TenantId;
    readonly id: string;
  }): Promise<readonly GatePolicy[]>;
  /** Each policy's latest active version. */
  list(input: GatePolicyListInput): Promise<{
    readonly data: readonly GatePolicy[];
    readonly nextCursor?: Cursor;
  }>;
  unregister(input: GatePolicyVersionInput): Promise<Result<GatePolicy, GatePolicyError>>;
  reinstate(input: GatePolicyVersionInput): Promise<Result<GatePolicy, GatePolicyError>>;
  /**
   * The policy that gates a promotion of `agentId` for `scope`: the most
   * specific scope with an active policy (a segment path's longer
   * prefixes first, then its project, the project's org, the tenant), at
   * its latest active version. `null`: no policy, so no gate.
   */
  resolve(input: {
    readonly tenantId: TenantId;
    readonly agentId: string;
    readonly scope: LiveScope;
  }): Promise<GatePolicy | null>;
}
