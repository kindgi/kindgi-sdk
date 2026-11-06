// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test sets — versioned catalog of evaluation specs.
 *
 * @wire /v1/test-sets/*  (packages/api/src/routes/test-sets.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Same versioned-registry shape as agents/tools/flows/policies:
 * publish new versions, list, get latest, list versions, un/reinstate
 * a specific version (soft-delete tombstone).
 */

import { type InvalidRequestError, KindgiApiError } from '../errors.js';
import type {
  CorrectedTestCase,
  CorrectedTestCaseCollectionPage,
  PublishTestSetBody,
  PublishTestSetResult,
  ReinstateTestSetVersionResult,
  ScopeKind,
  TestSet,
  TestSetCollectionPage,
  TestSetKind,
  UnregisterTestSetResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';
import type { GetLatestOptions } from '../types.js';

export type {
  PublishTestSetResult,
  ReinstateTestSetVersionResult,
  TestSet,
} from '../generated/api.js';
export type TestSetPage = TestSetCollectionPage;
/**
 * The test set fields of `POST /v1/test-sets`. The project the test set is
 * published into travels as `PublishTestSetOptions.projectId`; it is
 * omitted here so the input stays the project-agnostic test set shape.
 */
export type PublishTestSetInput = Omit<PublishTestSetBody, 'projectId'>;
export type UnregisterTestSetVersionResult = UnregisterTestSetResult;
// Note: the wire type is called `UnregisterTestSetResult`
// (test-set-scoped, though the route path is versioned).

/** One case of a `corrections` test set: a copy of a corrected run with its items' corrections summed up. */
export type TestSetCase = CorrectedTestCase;
export type TestSetCasePage = CorrectedTestCaseCollectionPage;

export interface ListTestSetCasesQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PublishTestSetOptions {
  /** Project the test set is published into. `POST /v1/test-sets` requires it. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface ListTestSetsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /**
   * One kind only. `corrections` is listed only when asked for here: an
   * agent's corrections are its test set (`agents.testSet`), and its frozen
   * versions are `corrections` test sets.
   */
  readonly kind?: TestSetKind;
  readonly name?: string;
  readonly scopeKind?: ScopeKind;
  readonly scopeId?: string;
  readonly inherit?: boolean;
  /**
   * List retired test sets too (every version unregistered), each as its
   * highest version with `unregisteredAt`. Default: `false`.
   */
  readonly includeRetired?: boolean;
}

export interface ListTestSetVersionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /**
   * List unregistered versions too, each with `unregisteredAt` (a
   * retired test set's included). Default: `false` (active versions only).
   */
  readonly includeTombstoned?: boolean;
}

export interface TestSetsClient {
  /**
   * Publish a test set version into a project (`options.projectId`, sent
   * next to the test set fields in the request body; `400 bad-input` when
   * it does not name a project in the workspace). An `id` starting `agent.`
   * is an agent's own test set, which the API refuses to publish: it's
   * refused here with `invalid-request`, and no request is sent.
   *
   * @wire POST /v1/test-sets
   */
  publish(
    input: PublishTestSetInput,
    options: PublishTestSetOptions,
  ): Promise<PublishTestSetResult>;
  /** @wire GET /v1/test-sets */
  list(filter?: ListTestSetsFilter): Promise<TestSetPage>;
  /** @wire GET /v1/test-sets/:testSetId — latest active version (`GetLatestOptions`) */
  get(testSetId: string, options?: GetLatestOptions): Promise<TestSet>;
  /**
   * The cases of a `corrections` test set version, in stored order.
   *
   * @wire GET /v1/test-sets/:testSetId/versions/:version/cases
   */
  listCases(
    testSetId: string,
    version: string,
    query?: ListTestSetCasesQuery,
  ): Promise<TestSetCasePage>;
  readonly versions: TestSetVersionsClient;
}

export interface TestSetVersionsClient {
  /** @wire GET /v1/test-sets/:testSetId/versions */
  list(testSetId: string, filter?: ListTestSetVersionsFilter): Promise<TestSetPage>;
  /** @wire GET /v1/test-sets/:testSetId/versions/:version */
  get(testSetId: string, version: string): Promise<TestSet>;
  /** @wire POST /v1/test-sets/:testSetId/versions/:version/unregister */
  unregister(
    testSetId: string,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterTestSetVersionResult>;
  /** @wire POST /v1/test-sets/:testSetId/versions/:version/reinstate */
  reinstate(
    testSetId: string,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateTestSetVersionResult>;
}

/** How every agent's test set id starts: the API refuses to publish one (`400 bad-input`). */
const AGENT_TEST_SET_ID_PREFIX = 'agent.';

/** Refuses an agent's test set id before a request is sent, with the API's words. */
function refuseAgentTestSetId(testSetId: string, path: string): void {
  if (!testSetId.startsWith(AGENT_TEST_SET_ID_PREFIX)) return;
  const error: InvalidRequestError = {
    code: 'invalid-request',
    message: `Test set ids starting \`${AGENT_TEST_SET_ID_PREFIX}\` are agents' own test sets, and only a test run or a suggested change's check makes their versions. Publish "${testSetId}" under another id.`,
    issues: [{ path, message: "reserved for agents' own test sets" }],
  };
  throw new KindgiApiError(error);
}

export function makeTestSetsClient(transport: Transport): TestSetsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async publish(input, options) {
      refuseAgentTestSetId(input.id, '/id');
      return transport.request<PublishTestSetResult>({
        method: 'POST',
        path: '/v1/test-sets',
        body: { ...input, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<TestSetPage>({
        method: 'GET',
        path: '/v1/test-sets',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.kind !== undefined && { kind: filter.kind }),
          ...(filter?.name !== undefined && { name: filter.name }),
          ...(filter?.scopeKind !== undefined && { scopeKind: filter.scopeKind }),
          ...(filter?.scopeId !== undefined && { scopeId: filter.scopeId }),
          ...(filter?.inherit !== undefined && { inherit: filter.inherit }),
          ...(filter?.includeRetired === true && { includeRetired: 'true' }),
        },
      });
    },
    async get(testSetId, options) {
      return transport.request<TestSet>({
        method: 'GET',
        path: `/v1/test-sets/${seg(testSetId)}`,
        query: { ...(options?.projectId !== undefined && { projectId: options.projectId }) },
      });
    },
    async listCases(testSetId, version, query) {
      return transport.request<TestSetCasePage>({
        method: 'GET',
        path: `/v1/test-sets/${seg(testSetId)}/versions/${seg(version)}/cases`,
        query: {
          ...(query?.limit !== undefined && { limit: query.limit }),
          ...(query?.cursor !== undefined && { cursor: query.cursor }),
        },
      });
    },
    versions: {
      async list(testSetId, filter) {
        return transport.request<TestSetPage>({
          method: 'GET',
          path: `/v1/test-sets/${seg(testSetId)}/versions`,
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.includeTombstoned === true && { includeTombstoned: 'true' }),
          },
        });
      },
      async get(testSetId, version) {
        return transport.request<TestSet>({
          method: 'GET',
          path: `/v1/test-sets/${seg(testSetId)}/versions/${seg(version)}`,
        });
      },
      async unregister(testSetId, version, options) {
        return transport.request<UnregisterTestSetVersionResult>({
          method: 'POST',
          path: `/v1/test-sets/${seg(testSetId)}/versions/${seg(version)}/unregister`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async reinstate(testSetId, version, options) {
        return transport.request<ReinstateTestSetVersionResult>({
          method: 'POST',
          path: `/v1/test-sets/${seg(testSetId)}/versions/${seg(version)}/reinstate`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
  };
}
