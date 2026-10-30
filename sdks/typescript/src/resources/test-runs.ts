// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test runs — start + observe evaluation-test set executions.
 *
 * @wire /v1/test-runs/*  and  /v1/test-sets/:testSetId/runs
 *   (packages/api/src/routes/test-runs.ts)
 * @generated Wire shapes from `../generated/api.js`.
 */

import type {
  CorrectedComparisonResult,
  TestRun,
  TestRunCollectionPage,
  TestRunStatus,
  StartTestRunBody,
  StartTestRunResult,
} from '../generated/api.js';
import { readSse, unwrapSseData } from '../streaming.js';
import type { Transport } from '../transport.js';

export type TestRunRecord = TestRun;
export type TestRunPage = TestRunCollectionPage;
/**
 * The run fields of `POST /v1/test-sets/:testSetId/runs` (exactly one of
 * `agentRef` / `flowRef`). The project the run belongs to travels as
 * `StartTestRunOptions.projectId`.
 */
export type StartTestRunInput = Omit<StartTestRunBody, 'projectId'>;
export type StartTestRunOutcome = StartTestRunResult;
export type {
  ComparisonCandidate,
  ComparisonCaseResult,
  ComparisonMetric,
  CorrectedComparisonResult,
  CorrectedComparisonSummary,
} from '../generated/api.js';

/**
 * A comparison's result, typed from the OpenAPI `CorrectedComparisonResult`:
 * its summary and each case. `run` is a `corrections` test run (a test set
 * compared with a version); `undefined` for another kind of test run, a
 * dry run, or one that hasn't finished.
 */
export function comparisonOf(run: TestRunRecord): CorrectedComparisonResult | undefined {
  const result = run.result as Partial<CorrectedComparisonResult> | undefined;
  return run.kind === 'corrections' &&
    result?.summary !== undefined &&
    Array.isArray(result.perCase)
    ? (result as CorrectedComparisonResult)
    : undefined;
}

export interface StartTestRunOptions {
  /** Project the test run belongs to. The route requires it. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface ListTestRunsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly testSetId?: string;
  readonly status?: TestRunStatus;
  readonly agentId?: string;
}

/**
 * The wire declares the SSE frame payload as unknown — payloads are
 * dispatcher-defined. Callers narrow.
 */
export type TestRunEvent = unknown;

export interface TestRunsClient {
  /**
   * Start a test-set run against the current test set version, in a
   * project (`options.projectId`, sent next to the run fields in the
   * request body).
   * @wire POST /v1/test-sets/:testSetId/runs
   */
  start(
    testSetId: string,
    input: StartTestRunInput,
    options: StartTestRunOptions,
  ): Promise<StartTestRunOutcome>;
  /** @wire GET /v1/test-runs */
  list(filter?: ListTestRunsFilter): Promise<TestRunPage>;
  /** @wire GET /v1/test-runs/:testRunId */
  get(testRunId: string): Promise<TestRunRecord>;
  /** @wire POST /v1/test-runs/:testRunId/cancel */
  cancel(testRunId: string): Promise<TestRunRecord>;
  /**
   * Rescore a completed comparison: a new test run that replays nothing and
   * scores the run's replays again, with the corrections recorded on them
   * since. `projectId` only for a runtime that doesn't record the run's.
   * @wire POST /v1/test-runs/:testRunId/rescore
   */
  rescore(
    testRunId: string,
    options?: { readonly projectId?: string },
  ): Promise<StartTestRunOutcome>;
  /**
   * SSE stream of dispatcher-emitted events.
   * @wire GET /v1/test-runs/:testRunId/events
   */
  events(
    testRunId: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly initialBackoffMs?: number;
      readonly maxBackoffMs?: number;
    },
  ): AsyncIterable<TestRunEvent>;
}

export function makeTestRunsClient(transport: Transport): TestRunsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async start(testSetId, input, options) {
      return transport.request<StartTestRunOutcome>({
        method: 'POST',
        path: `/v1/test-sets/${seg(testSetId)}/runs`,
        body: { ...input, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<TestRunPage>({
        method: 'GET',
        path: '/v1/test-runs',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.testSetId !== undefined && { testSetId: filter.testSetId }),
          ...(filter?.status !== undefined && { status: filter.status }),
          ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
        },
      });
    },
    async get(testRunId) {
      return transport.request<TestRunRecord>({
        method: 'GET',
        path: `/v1/test-runs/${seg(testRunId)}`,
      });
    },
    async cancel(testRunId) {
      return transport.request<TestRunRecord>({
        method: 'POST',
        path: `/v1/test-runs/${seg(testRunId)}/cancel`,
      });
    },
    async rescore(testRunId, options) {
      return transport.request<StartTestRunOutcome>({
        method: 'POST',
        path: `/v1/test-runs/${seg(testRunId)}/rescore`,
        body: options?.projectId !== undefined ? { projectId: options.projectId } : {},
      });
    },
    events(testRunId, options) {
      const url = `${transport.apiUrl}/v1/test-runs/${seg(testRunId)}/events`;
      const source = readSse<TestRunEvent>({
        url,
        headers: transport.authHeaders(),
        fetchImpl: transport.fetchImpl,
        ...(options?.signal !== undefined && { signal: options.signal }),
        ...(options?.initialBackoffMs !== undefined && {
          initialBackoffMs: options.initialBackoffMs,
        }),
        ...(options?.maxBackoffMs !== undefined && {
          maxBackoffMs: options.maxBackoffMs,
        }),
      });
      return unwrapSseData(source);
    },
  };
}
