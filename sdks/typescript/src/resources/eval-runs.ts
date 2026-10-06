// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Eval runs — start + observe evaluation-suite executions.
 *
 * @wire /v1/eval-runs/*  and  /v1/eval-suites/:suiteId/runs
 *   (packages/api/src/routes/eval-runs.ts)
 * @generated Wire shapes from `../generated/api.js`.
 */

import type {
  EvalRun,
  EvalRunCollectionPage,
  EvalRunStatus,
  JudgedComparisonResult,
  StartEvalRunBody,
  StartEvalRunResult,
} from '../generated/api.js';
import { readSse, unwrapSseData } from '../streaming.js';
import type { Transport } from '../transport.js';

export type EvalRunRecord = EvalRun;
export type EvalRunPage = EvalRunCollectionPage;
/**
 * The run fields of `POST /v1/eval-suites/:suiteId/runs` (exactly one of
 * `agentRef` / `flowRef`). The project the run belongs to travels as
 * `StartEvalRunOptions.projectId`.
 */
export type StartEvalRunInput = Omit<StartEvalRunBody, 'projectId'>;
export type StartEvalRunOutcome = StartEvalRunResult;
export type {
  ComparisonCandidate,
  ComparisonCaseResult,
  ComparisonMetric,
  JudgedComparisonResult,
  JudgedComparisonSummary,
} from '../generated/api.js';

/**
 * A comparison's result, typed from the OpenAPI `JudgedComparisonResult`:
 * its summary and each case. `run` is a `judged` eval run (a test set
 * compared with a version); `undefined` for another kind of eval run, a
 * dry run, or one that hasn't finished.
 */
export function comparisonOf(run: EvalRunRecord): JudgedComparisonResult | undefined {
  const result = run.result as Partial<JudgedComparisonResult> | undefined;
  return run.kind === 'judged' && result?.summary !== undefined && Array.isArray(result.perCase)
    ? (result as JudgedComparisonResult)
    : undefined;
}

export interface StartEvalRunOptions {
  /** Project the eval run belongs to. The route requires it. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface ListEvalRunsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly suiteId?: string;
  readonly status?: EvalRunStatus;
  readonly agentId?: string;
}

/**
 * The wire declares the SSE frame payload as unknown — payloads are
 * dispatcher-defined. Callers narrow.
 */
export type EvalRunEvent = unknown;

export interface EvalRunsClient {
  /**
   * Start an eval-suite run against the current suite version, in a
   * project (`options.projectId`, sent next to the run fields in the
   * request body).
   * @wire POST /v1/eval-suites/:suiteId/runs
   */
  start(
    suiteId: string,
    input: StartEvalRunInput,
    options: StartEvalRunOptions,
  ): Promise<StartEvalRunOutcome>;
  /** @wire GET /v1/eval-runs */
  list(filter?: ListEvalRunsFilter): Promise<EvalRunPage>;
  /** @wire GET /v1/eval-runs/:runId */
  get(runId: string): Promise<EvalRunRecord>;
  /** @wire POST /v1/eval-runs/:runId/cancel */
  cancel(runId: string): Promise<EvalRunRecord>;
  /**
   * SSE stream of dispatcher-emitted events.
   * @wire GET /v1/eval-runs/:runId/events
   */
  events(
    runId: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly initialBackoffMs?: number;
      readonly maxBackoffMs?: number;
    },
  ): AsyncIterable<EvalRunEvent>;
}

export function makeEvalRunsClient(transport: Transport): EvalRunsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async start(suiteId, input, options) {
      return transport.request<StartEvalRunOutcome>({
        method: 'POST',
        path: `/v1/eval-suites/${seg(suiteId)}/runs`,
        body: { ...input, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<EvalRunPage>({
        method: 'GET',
        path: '/v1/eval-runs',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.suiteId !== undefined && { suiteId: filter.suiteId }),
          ...(filter?.status !== undefined && { status: filter.status }),
          ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
        },
      });
    },
    async get(runId) {
      return transport.request<EvalRunRecord>({
        method: 'GET',
        path: `/v1/eval-runs/${seg(runId)}`,
      });
    },
    async cancel(runId) {
      return transport.request<EvalRunRecord>({
        method: 'POST',
        path: `/v1/eval-runs/${seg(runId)}/cancel`,
      });
    },
    events(runId, options) {
      const url = `${transport.apiUrl}/v1/eval-runs/${seg(runId)}/events`;
      const source = readSse<EvalRunEvent>({
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
