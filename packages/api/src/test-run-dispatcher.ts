// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type { ReplayTurnReport } from '@kindgi/agents';
import type { FlowVersionOverrides } from '@kindgi/flow';
import type { RunReplayRef } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import type {
  AgentRef,
  FlowRef,
  TestRun,
  TestRunBinding,
  TestRunCancelInput,
  TestRunCancelOutcome,
  TestRunComparison,
  TestRunGetInput,
  TestRunListInput,
  TestRunPage,
  TestRunStartInput,
  TestRunStartOutcome,
  TestRunStatus,
} from './test-run-binding.js';
import { TEST_RUN_STATUSES } from './test-run-binding.js';
import type { TestSet, TestSetKind, TestSetRegistryBinding } from './test-set-binding.js';

/**
 * Reference test-run dispatcher — proves the pattern end-to-end for
 * the `accuracy` kind with an in-process `TestRunBinding` that wraps
 * an in-memory run store. Durable deployments swap this for a
 * dispatcher that starts real runs (`runGraph`) so the TestRun is a
 * specialized run and inherits durability + replay + cancel.
 *
 * The in-process shape lets tests wire a subject invoker + a judge
 * without booting a full runtime — the surface (`TestRunBinding`) is
 * identical to what a durable deployment exposes.
 */

// ---------- dispatcher-per-kind primitive ----------

export interface EvalCase {
  readonly id?: string;
  readonly input: unknown;
  readonly expected?: unknown;
  readonly expectedOutput?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TestRunSubjectInvokeInput {
  readonly tenantId: TenantId;
  readonly target: AgentRef | FlowRef;
  readonly input: unknown;
  readonly dryRun: boolean;
  readonly abortSignal: AbortSignal;
  /** The test run's project: where the subject runs. */
  readonly projectId?: ProjectId;
  /**
   * Set when the subject re-runs a past run (a comparison test run): the
   * run is a replay of `of` for the test run, under the replay rules
   * (`InvokeAgentInput.replay`).
   */
  readonly replay?: RunReplayRef;
  /** The conversation before the past turn, oldest first: a replayed turn starts from it. */
  readonly history?: readonly unknown[];
  /** A flow target's agents and tools at other exact versions (`TestRunComparison.versions`). */
  readonly versions?: FlowVersionOverrides;
}

export interface TestRunSubjectInvokeOutcome {
  readonly output?: unknown;
  readonly error?: string;
  readonly costUsd?: number;
  readonly durationMs?: number;
  /** The run the subject ran in. */
  readonly runId?: RunId;
  /** A replay's report: each tool call and what happened to it (`AgentTurnResult.replay`). */
  readonly replay?: ReplayTurnReport;
  /** The provider and model that answered. */
  readonly provider?: { readonly id: string; readonly model: string };
  /**
   * Set when a replayed flow stopped at a tool call the replay refused (a
   * write the past run didn't make): no output, and what it would have
   * done. Not an error: the replay did what it's meant to.
   */
  readonly stopped?: {
    readonly toolId: string;
    readonly arguments: unknown;
    readonly reason?: string;
  };
  /**
   * The past run was erased after the case was read (a person's words
   * were removed): nothing was replayed. Not an error: the dispatcher
   * leaves the case out and counts it, like a case erased before. A
   * runtime that predates erasure never sets it.
   */
  readonly erased?: true;
  /**
   * The case couldn't start: its project or tenant takes no new runs
   * (`project-suspended`, `tenant-suspended`, `tenant-closing`, as a run
   * start is refused). Not the case's error: the dispatcher stops at it,
   * counting it nowhere, and the test run ends `cancelled` with `reason`
   * as its `cancelReason`. A runtime that refuses no starts never sets it.
   */
  readonly halt?: { readonly reason: string; readonly message: string };
}

/**
 * Caller-plugged subject invoker. Real deployments route this into
 * `RunHandlerBinding.invokeAgent` / `invokeFlow` (the same surface
 * `/v1/runs` uses); tests pass a synchronous stub.
 */
export interface EvalSubjectInvoker {
  invoke(input: TestRunSubjectInvokeInput): Promise<TestRunSubjectInvokeOutcome>;
}

/**
 * Grader contract used by the reference accuracy dispatcher —
 * deployments can plug in an eval-judge adapter or an LLM judge. Kept
 * local to `@kindgi/api` so the API package does not depend on an
 * evals package (it stays consumer-neutral).
 */
export interface EvalGrader {
  readonly id: string;
  grade(input: EvalGraderInput): Promise<EvalGraderOutcome>;
}

export interface EvalGraderInput {
  readonly caseInput: unknown;
  readonly actualOutput: unknown;
  readonly expected: unknown;
}

export interface EvalGraderOutcome {
  readonly pass: boolean;
  readonly score: number;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DispatchContext {
  readonly tenantId: TenantId;
  readonly testRunId: RunId;
  readonly testSet: TestSet;
  readonly target: AgentRef | FlowRef;
  readonly dryRun: boolean;
  readonly abortSignal: AbortSignal;
  readonly subject: EvalSubjectInvoker;
  /** The test run's project. */
  readonly projectId?: ProjectId;
  /** A comparison test run's baseline, reads and repetitions. */
  readonly comparison?: TestRunComparison;
  onProgress(perCase: Readonly<Record<string, unknown>>): void;
}

export interface DispatchResult {
  readonly result: Readonly<Record<string, unknown>>;
  readonly error?: string;
  /** With `error: 'cancelled'`: why it stopped when nobody cancelled it (a case's `halt`). */
  readonly cancelReason?: string;
}

export interface TestRunDispatcher {
  readonly kind: TestSetKind;
  validate?(
    testSet: TestSet,
    target: AgentRef | FlowRef,
    comparison?: TestRunComparison,
  ): { kind: 'ok' } | { kind: 'err'; message: string };
  dispatch(ctx: DispatchContext): Promise<DispatchResult>;
}

// ---------- reference accuracy dispatcher ----------

export interface AccuracyDispatcherOptions {
  readonly grader: EvalGrader;
}

/**
 * Reference dispatcher for `TestSetKind === 'accuracy'`. Reads
 * `spec.cases` from the registered test set; for each case, invokes the
 * subject with `case.input`, grades `(caseInput, actualOutput,
 * case.expected ?? case.expectedOutput)` through the injected
 * `EvalGrader`, and aggregates `{ passCount, totalCount, meanScore,
 * perCase[] }`.
 *
 * A dry-run echoes the plan (case count + first-case preview) without
 * invoking the subject — proves the same envelope is available on
 * `dryRun: true` requests. Callers use it as a sanity check before
 * paying for the real run.
 */
export function createAccuracyDispatcher(options: AccuracyDispatcherOptions): TestRunDispatcher {
  return {
    kind: 'accuracy',
    validate(testSet): { kind: 'ok' } | { kind: 'err'; message: string } {
      const cases = extractCases(testSet.spec);
      if (cases === null) {
        return { kind: 'err', message: 'accuracy test set.spec.cases must be an array' };
      }
      if (cases.length === 0) {
        return { kind: 'err', message: 'accuracy test set.spec.cases must not be empty' };
      }
      return { kind: 'ok' };
    },
    async dispatch(ctx): Promise<DispatchResult> {
      const cases = extractCases(ctx.testSet.spec) ?? [];
      if (ctx.dryRun) {
        return {
          result: {
            passCount: 0,
            totalCount: cases.length,
            meanScore: 0,
            perCase: [],
            dryRun: true,
            preview: cases.slice(0, 1).map((c, i) => ({
              caseIndex: i,
              input: c.input,
              expected: extractExpected(c),
            })),
          },
        };
      }
      const perCase: Record<string, unknown>[] = [];
      let passCount = 0;
      let scoreSum = 0;
      // Cancelled, or halted (`cancelReason`): the cases so far.
      const cancelled = (cancelReason?: string): DispatchResult => ({
        result: {
          passCount,
          totalCount: cases.length,
          meanScore: perCase.length > 0 ? scoreSum / perCase.length : 0,
          perCase,
          cancelled: true,
        },
        error: 'cancelled',
        ...(cancelReason !== undefined && { cancelReason }),
      });
      for (let i = 0; i < cases.length; i++) {
        if (ctx.abortSignal.aborted) return cancelled();
        const c = cases[i];
        if (c === undefined) continue;
        const expected = extractExpected(c);
        const invocation = await ctx.subject.invoke({
          tenantId: ctx.tenantId,
          target: ctx.target,
          input: c.input,
          dryRun: ctx.dryRun,
          abortSignal: ctx.abortSignal,
        });
        if (invocation.halt !== undefined) return cancelled(invocation.halt.reason);
        if (invocation.error !== undefined) {
          const entry = {
            caseIndex: i,
            ...(c.id !== undefined && { caseId: c.id }),
            pass: false,
            score: 0,
            error: invocation.error,
          };
          perCase.push(entry);
          ctx.onProgress(entry);
          continue;
        }
        const grade = await options.grader.grade({
          caseInput: c.input,
          actualOutput: invocation.output,
          expected,
        });
        if (grade.pass) passCount += 1;
        scoreSum += grade.score;
        const entry: Record<string, unknown> = {
          caseIndex: i,
          ...(c.id !== undefined && { caseId: c.id }),
          pass: grade.pass,
          score: grade.score,
          ...(grade.reason !== undefined && { reason: grade.reason }),
          ...(grade.metadata !== undefined && { judgeMetadata: grade.metadata }),
        };
        perCase.push(entry);
        ctx.onProgress(entry);
      }
      return {
        result: {
          passCount,
          totalCount: cases.length,
          meanScore: cases.length > 0 ? scoreSum / cases.length : 0,
          perCase,
        },
      };
    },
  };
}

function extractCases(spec: Readonly<Record<string, unknown>>): readonly EvalCase[] | null {
  const cases = spec.cases;
  if (!Array.isArray(cases)) return null;
  const out: EvalCase[] = [];
  for (const c of cases) {
    if (c === null || typeof c !== 'object') return null;
    const rec = c as Record<string, unknown>;
    if (!('input' in rec)) return null;
    out.push(rec as unknown as EvalCase);
  }
  return out;
}

function extractExpected(c: EvalCase): unknown {
  if (c.expected !== undefined) return c.expected;
  return c.expectedOutput;
}

// ---------- in-process TestRunBinding ----------

export interface InProcessTestRunBindingOptions {
  readonly testSetRegistry: TestSetRegistryBinding;
  readonly subject: EvalSubjectInvoker;
  readonly dispatchers: Partial<Record<TestSetKind, TestRunDispatcher>>;
  /**
   * Optional clock override — tests inject a monotonic stub so
   * timestamps are deterministic. Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
}

/**
 * Reference in-process `TestRunBinding`. Persists test-run rows in a
 * `Map<testRunId, TestRun>`; suitable for tests and dev deployments.
 * Production deployments swap in a durable binding that starts real
 * runs (`runGraph`) — the surface is identical, only the persistence +
 * execution substrate changes.
 *
 * A run starts as `running`, resolves per its dispatcher's outcome,
 * and can be cancelled via `AbortController.abort()` on the wrapped
 * controller. Cancellation is best-effort — a dispatcher that has
 * already returned cannot be undone; the row transitions to
 * `cancelled` and any partial `perCase` results are preserved.
 */
export function createInProcessTestRunBinding(
  options: InProcessTestRunBindingOptions,
): TestRunBinding {
  const now = options.now ?? ((): Date => new Date());
  const runs = new Map<string, TestRun>();
  const controllers = new Map<string, AbortController>();

  const setRun = (r: TestRun): void => {
    runs.set(r.testRunId as unknown as string, r);
  };

  return {
    async start(input: TestRunStartInput): Promise<TestRunStartOutcome> {
      const testSet =
        input.testSetVersion === undefined
          ? await options.testSetRegistry.get({
              tenantId: input.tenantId,
              testSetId: input.testSetId,
            })
          : await options.testSetRegistry.getVersion({
              tenantId: input.tenantId,
              testSetId: input.testSetId,
              version: input.testSetVersion,
            });
      if (testSet === null) {
        return { kind: 'test-set-not-found', testSetId: input.testSetId };
      }
      const dispatcher = options.dispatchers[testSet.kind];
      if (dispatcher === undefined) {
        return { kind: 'dispatcher-not-registered', evalKind: testSet.kind };
      }
      const target: AgentRef | FlowRef | undefined = input.agentRef ?? input.flowRef;
      if (target === undefined) {
        return {
          kind: 'dispatcher-input-invalid',
          message: 'agentRef or flowRef required',
        };
      }
      if (dispatcher.validate !== undefined) {
        const v = dispatcher.validate(testSet, target, input.comparison);
        if (v.kind === 'err') {
          return { kind: 'dispatcher-input-invalid', message: v.message };
        }
      }
      const testRunId = randomUUID() as unknown as RunId;
      const record = newRunRecord(input, testSet, testRunId, now());
      setRun(record);
      const controller = new AbortController();
      controllers.set(testRunId as unknown as string, controller);

      // Fire-and-forget the dispatch — completion updates the row.
      // Errors thrown by the dispatcher itself land the run in
      // `failed` (bug in the dispatcher, not a case-level failure).
      void (async (): Promise<void> => {
        let outcome: DispatchResult;
        try {
          outcome = await dispatcher.dispatch({
            tenantId: input.tenantId,
            testRunId,
            testSet,
            target,
            dryRun: input.dryRun === true,
            abortSignal: controller.signal,
            subject: options.subject,
            projectId: input.projectId,
            ...(input.comparison !== undefined && { comparison: input.comparison }),
            onProgress: (perCaseEntry: Readonly<Record<string, unknown>>) => {
              const current = runs.get(testRunId as unknown as string);
              if (current === undefined) return;
              const currentResult = (current.result ?? {}) as Record<string, unknown>;
              const perCase = Array.isArray(currentResult.perCase)
                ? [...(currentResult.perCase as unknown[]), perCaseEntry]
                : [perCaseEntry];
              setRun({
                ...current,
                result: { ...currentResult, perCase } as Readonly<Record<string, unknown>>,
              });
            },
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          const current = runs.get(testRunId as unknown as string);
          if (current === undefined) return;
          setRun({
            ...current,
            status: 'failed',
            completedAt: now().toISOString() as unknown as Timestamp,
            error: `Dispatcher threw: ${message}`,
          });
          return;
        }
        const current = runs.get(testRunId as unknown as string);
        if (current === undefined) return;
        if (current.status === 'cancelled') {
          // Cancel path already set the terminal row; preserve any
          // partial result the dispatcher produced.
          setRun({
            ...current,
            result: outcome.result,
            ...(current.completedAt === undefined && {
              completedAt: now().toISOString() as unknown as Timestamp,
            }),
          });
          return;
        }
        const status: TestRunStatus =
          outcome.error === undefined
            ? 'completed'
            : outcome.error === 'cancelled'
              ? 'cancelled'
              : 'failed';
        setRun({
          ...current,
          status,
          completedAt: now().toISOString() as unknown as Timestamp,
          result: outcome.result,
          ...(outcome.error !== undefined &&
            outcome.error !== 'cancelled' && {
              error: outcome.error,
            }),
          ...(status === 'cancelled' &&
            outcome.cancelReason !== undefined && { cancelReason: outcome.cancelReason }),
        });
      })();

      return { kind: 'ok', testRunId };
    },

    async get(input: TestRunGetInput): Promise<TestRun | null> {
      const record = runs.get(input.testRunId as unknown as string);
      if (record === undefined) return null;
      if ((record.tenantId as unknown as string) !== (input.tenantId as unknown as string)) {
        return null;
      }
      return record;
    },

    async list(input: TestRunListInput): Promise<TestRunPage> {
      const filter = input.filter ?? {};
      const all: TestRun[] = [];
      for (const r of runs.values()) {
        if ((r.tenantId as unknown as string) !== (input.tenantId as unknown as string)) continue;
        if (filter.testSetId !== undefined && r.testSetId !== filter.testSetId) continue;
        if (filter.status !== undefined && r.status !== filter.status) continue;
        if (filter.agentId !== undefined) {
          if (r.agentRef === undefined) continue;
          if ((r.agentRef.agentId as unknown as string) !== (filter.agentId as unknown as string)) {
            continue;
          }
        }
        if (filter.flowId !== undefined) {
          if (r.flowRef === undefined) continue;
          if ((r.flowRef.flowId as unknown as string) !== (filter.flowId as unknown as string)) {
            continue;
          }
        }
        if (filter.from !== undefined) {
          if ((r.startedAt as unknown as string) < (filter.from as unknown as string)) continue;
        }
        if (filter.to !== undefined) {
          if ((r.startedAt as unknown as string) > (filter.to as unknown as string)) continue;
        }
        all.push(r);
      }
      all.sort((a, b) => {
        const at = a.startedAt as unknown as string;
        const bt = b.startedAt as unknown as string;
        if (at !== bt) return at < bt ? 1 : -1;
        return (a.testRunId as unknown as string) < (b.testRunId as unknown as string) ? 1 : -1;
      });
      const cursor = input.cursor as unknown as string | undefined;
      const startAt =
        cursor === undefined
          ? 0
          : Math.max(0, all.findIndex((r) => (r.testRunId as unknown as string) === cursor) + 1);
      const slice = all.slice(startAt, startAt + input.limit);
      const hasMore = startAt + slice.length < all.length;
      const last = slice[slice.length - 1];
      return {
        data: slice,
        ...(hasMore &&
          last !== undefined && {
            nextCursor: last.testRunId as unknown as import('@kindgi/types').Cursor,
          }),
      };
    },

    async cancel(input: TestRunCancelInput): Promise<TestRunCancelOutcome> {
      const record = runs.get(input.testRunId as unknown as string);
      if (record === undefined) return { kind: 'not-found' };
      if ((record.tenantId as unknown as string) !== (input.tenantId as unknown as string)) {
        return { kind: 'not-found' };
      }
      if (isTerminal(record.status)) {
        return { kind: 'already-terminal', status: record.status };
      }
      const controller = controllers.get(input.testRunId as unknown as string);
      controller?.abort();
      setRun({
        ...record,
        status: 'cancelled',
        completedAt: now().toISOString() as unknown as Timestamp,
      });
      return { kind: 'ok' };
    },
  };
}

/** A started run's row: `running`, with what it runs and how. */
function newRunRecord(
  input: TestRunStartInput,
  testSet: TestSet,
  testRunId: RunId,
  at: Date,
): TestRun {
  return {
    testRunId,
    tenantId: input.tenantId,
    testSetId: testSet.id,
    testSetVersion: testSet.version,
    kind: testSet.kind,
    ...(input.agentRef !== undefined && { agentRef: input.agentRef }),
    ...(input.flowRef !== undefined && { flowRef: input.flowRef }),
    status: 'running',
    dryRun: input.dryRun === true,
    startedAt: at.toISOString() as unknown as Timestamp,
    ...(input.correlationId !== undefined && { correlationId: input.correlationId }),
    ...(input.comparison !== undefined && { comparison: input.comparison }),
    projectId: input.projectId,
  };
}

function isTerminal(status: TestRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// re-export for callers that only import the dispatcher module.
export { TEST_RUN_STATUSES };
