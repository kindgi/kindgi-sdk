// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Eval suites — versioned catalog of evaluation specs.
 *
 * @wire /v1/eval-suites/*  (packages/api/src/routes/eval-suites.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Same versioned-registry shape as agents/tools/flows/policies:
 * publish new versions, list, get latest, list versions, un/reinstate
 * a specific version (soft-delete tombstone).
 */

import type {
  BuildJudgedSuiteBody,
  BuildJudgedSuiteResult,
  EvalKind,
  EvalSuite,
  EvalSuiteCollectionPage,
  JudgedEvalCase,
  JudgedEvalCaseCollectionPage,
  PublishEvalSuiteBody,
  PublishEvalSuiteResult,
  ReinstateEvalSuiteVersionResult,
  ScopeKind,
  UnregisterEvalSuiteResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type Suite = EvalSuite;
export type SuitePage = EvalSuiteCollectionPage;
/**
 * The suite fields of `POST /v1/eval-suites`. The project the suite is
 * published into travels as `PublishSuiteOptions.projectId`; it is
 * omitted here so the input stays the project-agnostic suite shape.
 */
export type PublishSuiteInput = Omit<PublishEvalSuiteBody, 'projectId'>;
export type PublishSuiteResult = PublishEvalSuiteResult;
export type UnregisterSuiteVersionResult = UnregisterEvalSuiteResult;
// Note: the wire type is called `UnregisterEvalSuiteResult`
// (suite-scoped, though the route path is versioned).
export type ReinstateSuiteVersionResult = ReinstateEvalSuiteVersionResult;

/** Body of `POST /v1/eval-suites/{suiteId}/versions/from-judgments`. */
export type BuildFromJudgmentsInput = BuildJudgedSuiteBody;
export type BuildFromJudgmentsResult = BuildJudgedSuiteResult;
/** One case of a `judged` suite: a copy of a judged run with its items' judgments summed up. */
export type SuiteCase = JudgedEvalCase;
export type SuiteCasePage = JudgedEvalCaseCollectionPage;

export interface ListSuiteCasesQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PublishSuiteOptions {
  /** Project the suite is published into. `POST /v1/eval-suites` requires it. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface ListSuitesFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: EvalKind;
  readonly name?: string;
  readonly scopeKind?: ScopeKind;
  readonly scopeId?: string;
  readonly inherit?: boolean;
}

export interface ListSuiteVersionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface EvalSuitesClient {
  /**
   * Publish a suite version into a project (`options.projectId`, sent
   * next to the suite fields in the request body; `400 bad-input` when
   * it does not name a project in the tenant).
   *
   * @wire POST /v1/eval-suites
   */
  publish(input: PublishSuiteInput, options: PublishSuiteOptions): Promise<PublishSuiteResult>;
  /** @wire GET /v1/eval-suites */
  list(filter?: ListSuitesFilter): Promise<SuitePage>;
  /** @wire GET /v1/eval-suites/:suiteId */
  get(suiteId: string): Promise<Suite>;
  /**
   * Publish a `judged` suite version whose cases are copies of judged runs
   * of an agent or flow, with each item's judgments summed up. Needs
   * `admin` on `input.projectId`.
   *
   * @wire POST /v1/eval-suites/:suiteId/versions/from-judgments
   */
  buildFromJudgments(
    suiteId: string,
    input: BuildFromJudgmentsInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<BuildFromJudgmentsResult>;
  /**
   * The cases of a `judged` suite version, in stored order.
   *
   * @wire GET /v1/eval-suites/:suiteId/versions/:version/cases
   */
  listCases(suiteId: string, version: string, query?: ListSuiteCasesQuery): Promise<SuiteCasePage>;
  readonly versions: EvalSuiteVersionsClient;
}

export interface EvalSuiteVersionsClient {
  /** @wire GET /v1/eval-suites/:suiteId/versions */
  list(suiteId: string, filter?: ListSuiteVersionsFilter): Promise<SuitePage>;
  /** @wire GET /v1/eval-suites/:suiteId/versions/:version */
  get(suiteId: string, version: string): Promise<Suite>;
  /** @wire POST /v1/eval-suites/:suiteId/versions/:version/unregister */
  unregister(
    suiteId: string,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterSuiteVersionResult>;
  /** @wire POST /v1/eval-suites/:suiteId/versions/:version/reinstate */
  reinstate(
    suiteId: string,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateSuiteVersionResult>;
}

export function makeEvalSuitesClient(transport: Transport): EvalSuitesClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async publish(input, options) {
      return transport.request<PublishSuiteResult>({
        method: 'POST',
        path: '/v1/eval-suites',
        body: { ...input, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<SuitePage>({
        method: 'GET',
        path: '/v1/eval-suites',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.kind !== undefined && { kind: filter.kind }),
          ...(filter?.name !== undefined && { name: filter.name }),
          ...(filter?.scopeKind !== undefined && { scopeKind: filter.scopeKind }),
          ...(filter?.scopeId !== undefined && { scopeId: filter.scopeId }),
          ...(filter?.inherit !== undefined && { inherit: filter.inherit }),
        },
      });
    },
    async get(suiteId) {
      return transport.request<Suite>({
        method: 'GET',
        path: `/v1/eval-suites/${seg(suiteId)}`,
      });
    },
    async buildFromJudgments(suiteId, input, options) {
      return transport.request<BuildFromJudgmentsResult>({
        method: 'POST',
        path: `/v1/eval-suites/${seg(suiteId)}/versions/from-judgments`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async listCases(suiteId, version, query) {
      return transport.request<SuiteCasePage>({
        method: 'GET',
        path: `/v1/eval-suites/${seg(suiteId)}/versions/${seg(version)}/cases`,
        query: {
          ...(query?.limit !== undefined && { limit: query.limit }),
          ...(query?.cursor !== undefined && { cursor: query.cursor }),
        },
      });
    },
    versions: {
      async list(suiteId, filter) {
        return transport.request<SuitePage>({
          method: 'GET',
          path: `/v1/eval-suites/${seg(suiteId)}/versions`,
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          },
        });
      },
      async get(suiteId, version) {
        return transport.request<Suite>({
          method: 'GET',
          path: `/v1/eval-suites/${seg(suiteId)}/versions/${seg(version)}`,
        });
      },
      async unregister(suiteId, version, options) {
        return transport.request<UnregisterSuiteVersionResult>({
          method: 'POST',
          path: `/v1/eval-suites/${seg(suiteId)}/versions/${seg(version)}/unregister`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async reinstate(suiteId, version, options) {
        return transport.request<ReinstateSuiteVersionResult>({
          method: 'POST',
          path: `/v1/eval-suites/${seg(suiteId)}/versions/${seg(version)}/reinstate`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
  };
}
