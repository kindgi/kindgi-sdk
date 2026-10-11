// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AgentId,
  Cursor,
  DatasetId,
  Filter,
  FixProposalId,
  SupervisorId,
} from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { ListPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { DryRunCriterion, Supervisor, SupervisorSpec } from '../types.js';

/**
 * Supervisor resource — observers that watch agents, propose bounded
 * fixes on failure patterns, and route proposals through review.
 * Meta-fixes (fixes to a supervisor itself) route to the senior
 * reviewer class.
 *
 * Supervisors themselves have no API routes — `define` / `get` /
 * `list` / `versions` / `delete` throw `not-yet-wired`; a deployment
 * supplies supervisors through the `SupervisorBinding` it passes to the
 * API. Improvement proposals are `client.proposals`; the old
 * `.proposals` sub-namespace throws (removed in 0.1.5).
 */
export interface SupervisorClient {
  /**
   * @unwired No `POST /v1/supervisors` route — supervisors are
   *   supplied by the deployment's `SupervisorBinding`.
   *
   * @example
   * ```ts
   * const supervisorId = await client.supervisor.define({
   *   id: 'acme.citation-supervisor',
   *   version: '1.0.0',
   *   name: 'Citation Supervisor',
   *   subscribedAgents: ['acme.citation-verifier'],
   *   triggerGuardrails: ['must-cite-source', 'no-fabricated-quotes'],
   *   proposerTiers: ['prompt', 'retrieval'],
   *   defaultCriterion: { kind: 'strict-improvement', baselinePassRate: 0.8, minDelta: 0.05 },
   * });
   * ```
   */
  define(spec: SupervisorSpec): Promise<SupervisorId>;

  /** @unwired No `GET /v1/supervisors/{id}` route. */
  get(id: SupervisorId): Promise<Supervisor>;

  /** @unwired No `GET /v1/supervisors` route. */
  list(filter?: Filter): Promise<ListPage<Supervisor>>;

  /** @unwired No `GET /v1/supervisors/{id}/versions` route. */
  versions(id: SupervisorId): Promise<ListPage<Supervisor>>;

  /** @unwired No `DELETE /v1/supervisors/{id}` route. */
  delete(id: SupervisorId): Promise<void>;

  /** @deprecated Removed in 0.1.5: use `client.proposals`. Removed at 0.2. */
  readonly proposals: SupervisorProposalsClient;
}

/**
 * @deprecated Removed in 0.1.5: proposals now change data blocks. Every
 *   method throws a `not-yet-wired` error naming its replacement on
 *   `client.proposals` (`create`, `evaluate`, `request`, `rollback`,
 *   `withdraw`, `list`, `get`). Removed at 0.2.
 */
export interface SupervisorProposalsClient {
  /** @deprecated Use `client.proposals.create`. */
  draft(input: DraftProposalsInput): Promise<never>;
  /** @deprecated Use `client.proposals.list`. */
  list(input: ProposalListInput): Promise<never>;
  /** @deprecated Use `client.proposals.get`. */
  get(supervisorId: SupervisorId, id: FixProposalId): Promise<never>;
  /** @deprecated Use `client.proposals.evaluate`. */
  dryRun(supervisorId: SupervisorId, id: FixProposalId, input: ProposalDryRunInput): Promise<never>;
  /** @deprecated Use `client.proposals.request`. */
  submitForReview(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input?: SubmitForReviewInput,
  ): Promise<never>;
  /** @deprecated A proposal's review is its promotion's approval (`client.approvals`). */
  reflectReview(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input: ReflectReviewInput,
  ): Promise<never>;
  /** @deprecated Use `client.proposals.request`. */
  apply(supervisorId: SupervisorId, id: FixProposalId, input?: ApplyProposalInput): Promise<never>;
  /** @deprecated Use `client.proposals.rollback`. */
  rollback(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input: RollbackProposalInput,
  ): Promise<never>;
  /** @deprecated Use `client.proposals.withdraw`. */
  withdraw(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input: WithdrawProposalInput,
  ): Promise<never>;
}

/** @deprecated Input of the removed `client.supervisor.proposals`; removed at 0.2. */
export interface DraftProposalsInput {
  readonly supervisorId: SupervisorId;
  readonly agentId: AgentId;
  readonly agentVersion: string;
  readonly tier: 'prompt' | 'retrieval' | 'tool-config';
  /** Polymorphic change payload — shape depends on `tier`. */
  readonly change: Readonly<Record<string, unknown>>;
  readonly patternRefs: readonly Readonly<Record<string, unknown>>[];
  readonly hypothesis: string;
  readonly proposerRuleId: string;
  readonly idempotencyKey?: string;
}

/** @deprecated Input of the removed `client.supervisor.proposals`; removed at 0.2. */
export interface ProposalListInput {
  readonly supervisorId: SupervisorId;
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly status?: string;
  readonly agentId?: AgentId;
  readonly tier?: 'prompt' | 'retrieval' | 'tool-config';
}

/** @deprecated Input of the removed `client.supervisor.proposals`; removed at 0.2. */
export interface ProposalDryRunInput {
  readonly datasetId: DatasetId;
  readonly datasetVersion: string;
  readonly criterion: DryRunCriterion;
  readonly idempotencyKey?: string;
}

/** @deprecated Input of the removed `client.supervisor.proposals`; removed at 0.2. */
export interface SubmitForReviewInput {
  /** Override the auto-selected reviewer role (e.g. escalate to senior manually). */
  readonly requiredRole?: 'standard' | 'senior' | 'admin';
  /** ISO 8601 timestamp — HITL approval deadline. */
  readonly expiresAt?: import('@kindgi/types').Timestamp;
  readonly idempotencyKey?: string;
}

/**
 * @deprecated No `reflect-review` route; only the unwired
 *   `reflectReview` takes this input.
 */
export interface ReflectReviewInput {
  readonly decision: 'approved' | 'rejected' | 'changes-requested';
  readonly reviewerComments?: string;
}

/** @deprecated Input of the removed `client.supervisor.proposals`; removed at 0.2. */
export interface ApplyProposalInput {
  /** Override the auto-derived patch bump of the baseline. */
  readonly newVersion?: string;
  readonly idempotencyKey?: string;
}

/** @deprecated Input of the removed `client.supervisor.proposals`; removed at 0.2. */
export interface RollbackProposalInput {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

/** @deprecated Input of the removed `client.supervisor.proposals`; removed at 0.2. */
export interface WithdrawProposalInput {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

const REASON_NO_SUPERVISOR_CRUD =
  'no /v1/supervisors CRUD routes on the API — supervisor persistence is caller-plugged via SupervisorBinding at deployment boot (framework does NOT own supervisor storage; analogous to the identity-directory pattern for users)';

/** A removed `client.supervisor.proposals` method: it throws, naming its replacement. */
function removed(method: string, replacement: string): () => Promise<never> {
  return async () => {
    throw new KindgiApiError(
      notYetWired(
        `supervisor.proposals.${method}`,
        `removed in 0.1.5: proposals now change data blocks; use client.proposals.${replacement} (see client.proposals.create, evaluate and request)`,
      ),
    );
  };
}

export function makeSupervisorClient(_transport: Transport): SupervisorClient {
  return {
    async define(_spec) {
      throw new KindgiApiError(notYetWired('supervisor.define', REASON_NO_SUPERVISOR_CRUD));
    },
    async get(_id) {
      throw new KindgiApiError(notYetWired('supervisor.get', REASON_NO_SUPERVISOR_CRUD));
    },
    async list(_filter) {
      throw new KindgiApiError(notYetWired('supervisor.list', REASON_NO_SUPERVISOR_CRUD));
    },
    async versions(_id) {
      throw new KindgiApiError(notYetWired('supervisor.versions', REASON_NO_SUPERVISOR_CRUD));
    },
    async delete(_id) {
      throw new KindgiApiError(notYetWired('supervisor.delete', REASON_NO_SUPERVISOR_CRUD));
    },

    proposals: {
      draft: removed('draft', 'create'),
      list: removed('list', 'list'),
      get: removed('get', 'get'),
      dryRun: removed('dryRun', 'evaluate'),
      submitForReview: removed('submitForReview', 'request'),
      reflectReview: removed('reflectReview', 'request'),
      apply: removed('apply', 'request'),
      rollback: removed('rollback', 'rollback'),
      withdraw: removed('withdraw', 'withdraw'),
    },
  };
}
