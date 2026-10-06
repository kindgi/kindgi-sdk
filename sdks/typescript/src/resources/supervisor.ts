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
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  ApplyProposalResult,
  DryRunCriterion,
  DryRunProposalResult,
  FixProposal,
  FixProposalStatus,
  RollbackProposalResult,
  SubmitReviewProposalResult,
  Supervisor,
  SupervisorSpec,
} from '../types.js';

/**
 * Supervisor resource — observers that watch agents, propose bounded
 * fixes on failure patterns, and route proposals through review.
 * Meta-fixes (fixes to a supervisor itself) route to the senior
 * reviewer class.
 *
 * The API exposes the fix-proposal lifecycle as `/v1/proposals/*`
 * (see `packages/api/src/routes/proposals.ts`). Supervisors themselves
 * have no API routes — `define` / `get` / `list` / `versions` /
 * `delete` throw `not-yet-wired`; a deployment supplies supervisors
 * through the `SupervisorBinding` it passes to the API.
 *
 * Sub-namespace `.proposals` covers the fix-proposal lifecycle
 * (`draft → dryRun → submitForReview → apply | rollback | withdraw`).
 * Every `.proposals.*` call takes a `supervisorId`, sent as the
 * `X-Supervisor-Id` header. `reflectReview` has no route.
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

  readonly proposals: ProposalsClient;
}

export interface ProposalsClient {
  /**
   * Draft a fix proposal for `(agentId, agentVersion)`. Duplicate
   * proposals (same `(supervisor, fingerprint)` non-terminal) short-
   * circuit to the pre-existing row (the response carries
   * `X-Proposal-Deduped: true`). One proposal per call.
   *
   * @wire `POST /v1/proposals` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals/post`. Requires
   *   `X-Supervisor-Id` header (threaded from the `supervisorId`
   *   argument).
   */
  draft(input: DraftProposalsInput): Promise<FixProposal>;

  /**
   * Paginated list of proposals scoped to `(tenantId, supervisorId)`.
   *
   * @wire `GET /v1/proposals` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals/get`.
   */
  list(input: ProposalListInput): Promise<ListPage<FixProposal>>;

  /**
   * @wire `GET /v1/proposals/{proposalId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals~1{proposalId}/get`.
   */
  get(supervisorId: SupervisorId, id: FixProposalId): Promise<FixProposal>;

  /**
   * Dry-run a proposal against a held-out eval dataset.
   *
   * @wire `POST /v1/proposals/{proposalId}/dry-run` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals~1{proposalId}~1dry-run/post`.
   *   Returns `{ proposal, passed }`; `passed: false` is a legitimate
   *   outcome, not an error.
   */
  dryRun(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input: ProposalDryRunInput,
  ): Promise<DryRunProposalResult>;

  /**
   * Submit a dry-run-passed proposal for HITL review.
   *
   * @wire `POST /v1/proposals/{proposalId}/submit-review` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals~1{proposalId}~1submit-review/post`.
   *   Returns `{ proposal, approvalId, metaFix }`.
   */
  submitForReview(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input?: SubmitForReviewInput,
  ): Promise<SubmitReviewProposalResult>;

  /**
   * @unwired No `POST /v1/proposals/{id}/reflect-review` route. A
   *   proposal's review outcome follows from deciding its approval
   *   (`approvals.decide`).
   */
  reflectReview(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input: ReflectReviewInput,
  ): Promise<void>;

  /**
   * Apply an approved proposal: writes a new agent version and
   * transitions the proposal to `applied`.
   *
   * @wire `POST /v1/proposals/{proposalId}/apply` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals~1{proposalId}~1apply/post`.
   *   Returns `{ proposalId, appliedVersion, appliedAt }` — applying is
   *   a registry write, not a run.
   */
  apply(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input?: ApplyProposalInput,
  ): Promise<ApplyProposalResult>;

  /**
   * Roll back a previously-applied proposal. Unregisters the applied
   * version; transitions the proposal to `rolled-back`.
   *
   * @wire `POST /v1/proposals/{proposalId}/rollback` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals~1{proposalId}~1rollback/post`.
   *   Requires a non-empty `reason`.
   */
  rollback(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input: RollbackProposalInput,
  ): Promise<RollbackProposalResult>;

  /**
   * Withdraw a non-terminal proposal.
   *
   * @wire `POST /v1/proposals/{proposalId}/withdraw` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1proposals~1{proposalId}~1withdraw/post`.
   *   Requires a non-empty `reason`. Terminal-state calls surface as
   *   `409 proposal-invalid-state-transition`.
   */
  withdraw(
    supervisorId: SupervisorId,
    id: FixProposalId,
    input: WithdrawProposalInput,
  ): Promise<FixProposal>;
}

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

export interface ProposalListInput {
  readonly supervisorId: SupervisorId;
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly status?: FixProposalStatus;
  readonly agentId?: AgentId;
  readonly tier?: 'prompt' | 'retrieval' | 'tool-config';
}

export interface ProposalDryRunInput {
  readonly datasetId: DatasetId;
  readonly datasetVersion: string;
  readonly criterion: DryRunCriterion;
  readonly idempotencyKey?: string;
}

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

export interface ApplyProposalInput {
  /** Override the auto-derived patch bump of the baseline. */
  readonly newVersion?: string;
  readonly idempotencyKey?: string;
}

export interface RollbackProposalInput {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface WithdrawProposalInput {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

const REASON_NO_SUPERVISOR_CRUD =
  'no /v1/supervisors CRUD routes on the API — supervisor persistence is caller-plugged via SupervisorBinding at deployment boot (framework does NOT own supervisor storage; analogous to the identity-directory pattern for users)';

export function makeSupervisorClient(transport: Transport): SupervisorClient {
  const supervisorHeader = (supervisorId: SupervisorId): Record<string, string> => ({
    'X-Supervisor-Id': supervisorId as unknown as string,
  });

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
      async draft(input) {
        return transport.request<FixProposal>({
          method: 'POST',
          path: '/v1/proposals',
          headers: supervisorHeader(input.supervisorId),
          body: {
            agentId: input.agentId as unknown as string,
            agentVersion: input.agentVersion,
            tier: input.tier,
            change: input.change,
            patternRefs: input.patternRefs,
            hypothesis: input.hypothesis,
            proposerRuleId: input.proposerRuleId,
          },
          ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        });
      },

      async list(input) {
        const page = await transport.request<WirePage<FixProposal>>({
          method: 'GET',
          path: '/v1/proposals',
          headers: supervisorHeader(input.supervisorId),
          query: {
            ...(input.limit !== undefined && { limit: input.limit }),
            ...(input.cursor !== undefined && { cursor: input.cursor as unknown as string }),
            ...(input.status !== undefined && { status: input.status }),
            ...(input.agentId !== undefined && { agentId: input.agentId as unknown as string }),
            ...(input.tier !== undefined && { tier: input.tier }),
          },
        });
        return listPage(page);
      },

      async get(supervisorId, id) {
        return transport.request<FixProposal>({
          method: 'GET',
          path: `/v1/proposals/${encodeURIComponent(id as unknown as string)}`,
          headers: supervisorHeader(supervisorId),
        });
      },

      async dryRun(supervisorId, id, input) {
        return transport.request<DryRunProposalResult>({
          method: 'POST',
          path: `/v1/proposals/${encodeURIComponent(id as unknown as string)}/dry-run`,
          headers: supervisorHeader(supervisorId),
          body: {
            datasetId: input.datasetId as unknown as string,
            datasetVersion: input.datasetVersion,
            criterion: input.criterion,
          },
          ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        });
      },

      async submitForReview(supervisorId, id, input) {
        const body: Record<string, unknown> = {};
        if (input?.requiredRole !== undefined) body.requiredRole = input.requiredRole;
        if (input?.expiresAt !== undefined) body.expiresAt = input.expiresAt as unknown as string;
        return transport.request<SubmitReviewProposalResult>({
          method: 'POST',
          path: `/v1/proposals/${encodeURIComponent(id as unknown as string)}/submit-review`,
          headers: supervisorHeader(supervisorId),
          body,
          ...(input?.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        });
      },

      async reflectReview(_supervisorId, _id, _input) {
        throw new KindgiApiError(
          notYetWired(
            'supervisor.proposals.reflectReview',
            'no POST /v1/proposals/{id}/reflect-review route on the API — review reflection is atomic with POST /v1/approvals/{id}/complete (wire detects the linked proposal + updates status alongside the decision)',
          ),
        );
      },

      async apply(supervisorId, id, input) {
        const body: Record<string, unknown> = {};
        if (input?.newVersion !== undefined) body.newVersion = input.newVersion;
        return transport.request<ApplyProposalResult>({
          method: 'POST',
          path: `/v1/proposals/${encodeURIComponent(id as unknown as string)}/apply`,
          headers: supervisorHeader(supervisorId),
          body,
          ...(input?.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        });
      },

      async rollback(supervisorId, id, input) {
        return transport.request<RollbackProposalResult>({
          method: 'POST',
          path: `/v1/proposals/${encodeURIComponent(id as unknown as string)}/rollback`,
          headers: supervisorHeader(supervisorId),
          body: { reason: input.reason },
          ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        });
      },

      async withdraw(supervisorId, id, input) {
        return transport.request<FixProposal>({
          method: 'POST',
          path: `/v1/proposals/${encodeURIComponent(id as unknown as string)}/withdraw`,
          headers: supervisorHeader(supervisorId),
          body: { reason: input.reason },
          ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        });
      },
    },
  };
}
