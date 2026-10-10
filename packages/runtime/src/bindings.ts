// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Kernel-runtime binding interfaces. The public shape of what a
// deployment plugs into `createApp` for run lifecycle, scheduling,
// waitpoint timers, and retention. Implementations are supplied by the
// Kindgi runtime; a deployment can substitute individual sub-bindings.
//

import type { Result, RunId, TenantId } from '@kindgi/types';

import type { KernelError } from './errors.js';
import type { KernelEventBusBinding } from './event-bus.js';
import type {
  DeleteRunError,
  DeleteRunParams,
  ResumeRunInput,
  RunFlowInput,
  StartRunError,
  StartRunParams,
} from './inputs.js';
import type { FailureGroups, FailureGroupsInput } from './run-failures.js';
import type { KernelRunRecord, ListRunsInput, ListRunsPage } from './runs.js';
import type { TriggerRegistryBinding } from './schedulers/registry.js';
import type { JournalEntry, RunResult } from './types.js';

/**
 * Run-lifecycle binding. Every enforcement site (@kindgi/api routes,
 * @kindgi/agents invocation flow) that wants to start / resume /
 * cancel / read a run goes through this contract. The implementation
 * is supplied by the Kindgi runtime.
 */
export interface RunBinding {
  /**
   * Run a flow until it completes, fails, is cancelled or suspends.
   * Starts a new run, or — when `input.runId` is set — runs the
   * `pending` run `startRun` created.
   */
  runGraph<TOutput = unknown>(
    input: RunFlowInput,
  ): Promise<Result<RunResult<TOutput>, KernelError>>;

  /**
   * Resume a suspended or interrupted run. The journal is the source
   * of truth; every completed step is skipped and only outstanding
   * work is dispatched. `flow` + `handlers` must match the flow the
   * run was started with — versioned pinning refuses re-versioned
   * flows with `flow-mismatch`.
   */
  resumeRun<TOutput = unknown>(
    input: ResumeRunInput,
  ): Promise<Result<RunResult<TOutput>, KernelError>>;

  /**
   * Cancel an in-flight or suspended run. Journals `run.cancelled`;
   * outstanding handlers observe `ctx.abortSignal`. Optional
   * `eventBus` is used to publish the cancellation event alongside
   * the journal write.
   */
  cancelRun(
    tenantId: TenantId,
    runId: RunId,
    eventBus?: KernelEventBusBinding,
  ): Promise<Result<void, KernelError>>;

  /**
   * Cancel an outstanding waitpoint. The handler observing the token
   * via `ctx.waitForToken(...)` throws `WaitpointCancelledError` on
   * resume with the supplied `reason`. Journals `wait.cancelled`.
   */
  cancelToken(
    tenantId: TenantId,
    runId: RunId,
    tokenId: string,
    reason: string,
    eventBus?: KernelEventBusBinding,
  ): Promise<Result<void, KernelError>>;

  /**
   * Resolve an outstanding waitpoint with a value. The handler
   * observing the token via `ctx.waitForToken(...)` returns the value
   * on resume. Journals `wait.resumed`.
   */
  completeToken(
    tenantId: TenantId,
    runId: RunId,
    tokenId: string,
    value: unknown,
    eventBus?: KernelEventBusBinding,
  ): Promise<Result<void, KernelError>>;

  /**
   * Read the full ordered journal for a run — every entry, in
   * sequence order. The primitive routes + agents consume this for
   * SSE tailing + replay reconstruction.
   */
  readJournal(
    tenantId: TenantId,
    runId: RunId,
  ): Promise<Result<readonly JournalEntry[], KernelError>>;

  /**
   * Create a `pending` run without dispatching it. Used by callers
   * that want to hand back a `runId` synchronously and start the
   * run out-of-band (background workers, HTTP `POST /v1/runs` with
   * `wait: false` answering `202`, subgraph child dispatch); the run
   * is then executed with `runGraph({ ..., runId })`.
   */
  startRun(params: StartRunParams): Promise<
    Result<
      {
        readonly runId: RunId;
        /** Set when `params.idempotencyKey` named a run that already exists: nothing new started. */
        readonly existing?: true;
      },
      StartRunError
    >
  >;

  /**
   * Delete a run + its journal + waitpoints. Retention path;
   * `not-found` returned for missing runs so the caller can be
   * idempotent under concurrent deletes.
   */
  deleteRun(params: DeleteRunParams): Promise<Result<void, DeleteRunError>>;

  /**
   * Fetch a single run by id, scoped to tenant. Returns null if
   * the run doesn't exist or belongs to a different tenant. Callers
   * do additional authz gating (per-project scope) at the route
   * layer; this method is a straight tenant-scoped point-read.
   */
  getRun(tenantId: TenantId, runId: RunId): Promise<KernelRunRecord | null>;

  /**
   * List runs in `(createdAt desc, id desc)` order, cursor-
   * paginated. Filter by content scope: absent = tenant-wide,
   * `{ kind: 'project' }` narrows to one project, `{ kind: 'org' }`
   * includes every project in the org. `parent` narrows to a run's
   * children; `topLevelOnly` excludes child runs; `agentId` narrows to
   * one agent's turns (`KernelRunRecord.agent`).
   */
  listRuns(input: ListRunsInput): Promise<ListRunsPage>;

  /**
   * A project's failed runs over a window, grouped by cause (`failure.code`)
   * and version: counts, first and last seen, and the latest run of each
   * group. Replays, eval runs' runs and dry runs aren't counted; a child
   * run counts under its own agent or flow. Optional: without it, the
   * failures route answers `run-failures-not-supported`.
   */
  failureGroups?(input: FailureGroupsInput): Promise<FailureGroups>;
}

/**
 * Scheduler bootstrap binding. Deployments start/stop these long-
 * lived processes at boot; the trigger CRUD flows through
 * `TriggerRegistryBinding` separately.
 */
export interface SchedulerBinding {
  /**
   * Start the cron scheduler process. Returns a handle whose
   * `stop()` cleanly shuts it down. Deployments call this once at
   * boot and hold the handle for graceful-shutdown wiring.
   */
  startCronScheduler(options: CronSchedulerOptions): CronSchedulerHandle;

  /** Start the event-trigger scheduler process. */
  startEventTriggerScheduler(options: EventTriggerSchedulerOptions): EventTriggerSchedulerHandle;

  /**
   * Fire a specific webhook trigger by its webhookId. Called by a
   * webhook receiver AFTER it has verified the request's HMAC
   * signature. The scheduler resolves the trigger, dispatches the
   * flow, and journals the fire.
   */
  fireByWebhookId(input: FireByWebhookIdInput): Promise<Result<{ readonly runId: RunId }, unknown>>;

  /**
   * Compute the initial `nextFireAt` for a cron config. Called at
   * trigger register/update to precompute the first-fire timestamp
   * in the same write.
   */
  initialNextFireAt(
    config: { readonly cronExpression: string; readonly timezone?: string },
    now?: Date,
  ): Date;
}

export interface CronSchedulerOptions {
  readonly runFlowBinding: unknown; // caller-supplied RunFlowBinding; see @kindgi/runtime.RunFlowBinding
  readonly pollIntervalMs?: number;
  readonly logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface CronSchedulerHandle {
  stop(): Promise<void>;
}

export interface EventTriggerSchedulerOptions {
  readonly runFlowBinding: unknown;
  readonly logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface EventTriggerSchedulerHandle {
  stop(): Promise<void>;
}

export interface FireByWebhookIdInput {
  readonly tenantId: TenantId;
  readonly webhookId: string;
  readonly runFlowBinding: unknown;
  readonly requestBody: unknown;
}

/**
 * Waitpoint-timeout sleeper binding. A long-lived process that finds
 * waitpoints whose timeout has passed and cancels them with
 * `reason: 'timeout'`. Deployments start this at boot alongside the
 * schedulers.
 */
export interface WaitpointBinding {
  startTimeoutSleeper(options: WaitpointTimeoutSleeperOptions): WaitpointTimeoutSleeperHandle;
}

export interface WaitpointTimeoutSleeperOptions {
  readonly pollIntervalMs?: number;
  readonly logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface WaitpointTimeoutSleeperHandle {
  stop(): Promise<void>;
}

/**
 * Run retention binding. Deployments plug this in to have expired
 * runs (per tenant retention policy) reaped on a schedule.
 */
export interface RunRetentionBinding {
  createRetentionAdapter(options: RunRetentionOptions): RunRetentionAdapter;
}

export interface RunRetentionOptions {
  readonly logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface RunRetentionAdapter {
  reapExpired(input: { readonly tenantId: TenantId }): Promise<{ readonly deleted: number }>;
}

/**
 * Umbrella that groups every kernel-runtime binding. What
 * `CreateAppInput.kernelBinding` in `@kindgi/api` accepts. The Kindgi
 * runtime supplies the implementation.
 */
export interface KernelBinding {
  readonly run: RunBinding;
  readonly scheduler: SchedulerBinding;
  readonly waitpoint: WaitpointBinding;
  readonly retention: RunRetentionBinding;
  readonly triggers: TriggerRegistryBinding;
  readonly eventBus?: KernelEventBusBinding;
}
