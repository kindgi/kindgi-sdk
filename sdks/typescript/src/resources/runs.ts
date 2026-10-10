// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RunStatus } from '@kindgi/runtime';
import type { AgentId, FlowId, RunId, TenantId, Timestamp } from '@kindgi/types';
import type { ScopeRef } from '../scope-wire.js';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { LiveScope, RunFailureGroups, RunProgress, ScopeSegment } from '../generated/api.js';
import { type RunProgressEvent, followRun } from '../run-follow.js';
import { scopeToQuery } from '../scope-wire.js';
import { type Transport, seconds } from '../transport.js';
import type { DryRunResult, RunEvent } from '../types.js';

/**
 * Runs resource — the single execution primitive.
 *
 * Background jobs, webhook processors, scheduled tasks and agent
 * invocations all execute as flow runs; there is no separate queue
 * subsystem. Streaming is pull-model (`AsyncIterable` over SSE), not
 * callback-based.
 *
 * The SDK collapses "agent run" and "flow run" onto one resource
 * because they are one runtime primitive. `start` accepts either an
 * `AgentId` (the server runs the agent as a flow) or a `FlowId`
 * (the server runs the flow directly).
 */
export interface RunsClient {
  /**
   * Start a run. Server returns the full `Run` row so callers observe
   * `status` + `flowId` + `flowVersion` in one round-trip: by default
   * once the run completes, fails or suspends (201, with `output`);
   * with `options.wait: false` as soon as it exists (202) — poll
   * `get(runId)` until it finishes.
   *
   * A waited start is bound by the client's timeout (`timeoutMs`, 30 s by
   * default; this call can set its own). When it runs out, the run may
   * still be going and its id never arrived: the `network` error says so.
   * Start a run that can take longer with `options.wait: false`.
   *
   * `idempotencyKey` makes retries safe: two calls with the same key
   * within the server's retention window return the same `Run`.
   *
   * When the deployment issues public run tokens, the result also
   * carries `publicAccessToken`: hand it to a browser, which follows the
   * run with `subscribeToRun`.
   *
   * @wire `POST /v1/runs` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1runs/post`. Idempotency
   *   keys are accepted on all POSTs.
   */
  start(input: StartRunInput): Promise<StartedRun>;

  /**
   * @unwired No `POST /v1/runs/dry-run` route. To preview a run, use
   *   `runs.start({ ..., options: { dryRun: true } })`, which returns a
   *   `Run` marked `dryRun: true`. The `DryRunResult` shape (planned
   *   nodes, tool calls, cost estimate) has no API route.
   */
  dryRun(input: StartRunInput): Promise<DryRunResult>;

  /**
   * The run's events, once each, through to its terminal event
   * (`run.completed`, `run.failed` or `run.cancelled`), as an async
   * iterable. Python's `runs.follow` and the Java client's
   * `runs().follow` do the same.
   *
   * @wire `GET /v1/runs/{runId}/stream` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1runs~1{runId}~1stream/get`.
   *   Server emits SSE frames (`text/event-stream`), one wire `RunEvent`
   *   per frame with the SSE `id:` line set to `<runId>:<sequence>` for
   *   `Last-Event-Id` resume.
   *
   * Reconnect is transparent — network drops trigger exponential
   * backoff (500 ms → 30 s cap; up to 10 attempts by default) with
   * `Last-Event-Id` set to the last-observed frame so the server
   * resumes from the next sequence. When the server ends the stream
   * before the run finished (its 5-minute limit), the iterable
   * reconnects the same way; it completes after the run's terminal
   * event. Consumers pass `AbortSignal` for caller-side cancellation;
   * the iterable completes cleanly on abort.
   *
   * @param runId — the run to follow.
   * @param options — optional `signal` for cancellation + backoff overrides.
   */
  follow(
    runId: RunId,
    options?: {
      readonly signal?: AbortSignal;
      readonly initialBackoffMs?: number;
      readonly maxBackoffMs?: number;
    },
  ): AsyncIterable<RunEvent>;

  /**
   * The run's events, following it to its end, as `follow` does today.
   *
   * @deprecated Use `runs.follow`, which does the same. In a later minor
   *   release, announced in advance, `runs.stream` becomes the plain
   *   call, as in Python and Java: it ends when the server closes the
   *   stream (after the run's terminal event, or after 5 minutes).
   *
   * @wire `GET /v1/runs/{runId}/stream`
   */
  stream(
    runId: RunId,
    options?: {
      readonly signal?: AbortSignal;
      readonly initialBackoffMs?: number;
      readonly maxBackoffMs?: number;
    },
  ): AsyncIterable<RunEvent>;

  /**
   * The run's progress: status and timing, without its input, output or
   * failure message.
   *
   * @wire `GET /v1/runs/{runId}/progress`
   */
  progress(runId: RunId): Promise<RunProgress>;

  /**
   * The run's events without their payloads, through to the terminal one
   * (reconnecting like `follow`). Python's `runs.follow_progress` and the
   * Java client's `runs().followProgress` do the same. For browsers, see
   * `subscribeToRun`, which takes a public run token.
   *
   * @wire `GET /v1/runs/{runId}/progress/stream`
   */
  followProgress(
    runId: RunId,
    options?: {
      readonly signal?: AbortSignal;
      readonly initialBackoffMs?: number;
      readonly maxBackoffMs?: number;
    },
  ): AsyncIterable<RunProgressEvent>;

  /**
   * The run's progress events, following it to its end, as
   * `followProgress` does today.
   *
   * @deprecated Use `runs.followProgress`, which does the same. In a
   *   later minor release, announced in advance, `runs.streamProgress`
   *   becomes the plain call, as in Python and Java.
   *
   * @wire `GET /v1/runs/{runId}/progress/stream`
   */
  streamProgress(
    runId: RunId,
    options?: {
      readonly signal?: AbortSignal;
      readonly initialBackoffMs?: number;
      readonly maxBackoffMs?: number;
    },
  ): AsyncIterable<RunProgressEvent>;

  /**
   * Snapshot the current run status.
   *
   * @wire `GET /v1/runs/{runId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1runs~1{runId}/get`.
   */
  get(runId: RunId): Promise<Run>;

  /**
   * Resume a suspended run at a waitpoint. Used to complete HITL
   * approvals, external callbacks, or event-triggered inbox waits.
   *
   * @wire `POST /v1/runs/{runId}/resume` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1runs~1{runId}~1resume/post`.
   *
   * Returns the updated run row, so callers see the transition from
   * `suspended` back to `running` (or onward) without a follow-up
   * `get`.
   */
  resume(input: ResumeRunInput): Promise<Run>;

  /**
   * Request cancellation. The runtime journals `run.cancelled`;
   * in-flight handlers observe their abort signal.
   *
   * @wire `POST /v1/runs/{runId}/cancel` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1runs~1{runId}~1cancel/post`.
   *
   * Returns the updated run row.
   */
  cancel(runId: RunId, options?: { readonly idempotencyKey?: string }): Promise<Run>;

  /**
   * Cursor-paginated list of runs for the tenant.
   *
   * @wire `GET /v1/runs` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1runs/get`.
   */
  list(filter?: ListRunsFilter): Promise<RunPage>;

  /**
   * Read the durable journal for a run. Journal entries are the
   * source-of-truth history for replay + audit.
   *
   * @wire `GET /v1/runs/:runId/journal`
   */
  journal(runId: RunId, filter?: RunJournalFilter): Promise<RunJournalPage>;

  /**
   * A project's failed runs over a window (at most 90 days), grouped by
   * cause and version: per group, how many failed, when the first and the
   * latest failed, and the latest run. People's decisions (`hitl-*`) come
   * apart as `outcomes`; runs that failed before their cause was recorded,
   * as `unrecorded`. Needs `read` on the project.
   *
   * @wire `GET /v1/runs/failures`
   */
  failures(query: RunFailuresQuery): Promise<RunFailureGroups>;
}

export type { RunFailureGroups };

export interface RunFailuresQuery {
  readonly projectId: string;
  /** Runs that failed at or after this time. */
  readonly from: Date | string;
  /** Runs that failed before this time. */
  readonly to: Date | string;
  /** Only this agent's turns (not with `flowId`). */
  readonly agentId?: AgentId | string;
  /** Only this flow's runs (not with `agentId`). */
  readonly flowId?: FlowId | string;
  /** What to group by: `['code', 'version']` by default. */
  readonly groupBy?: readonly ('code' | 'version')[];
  /** The most groups in each list, 1 to 200 (50 by default). */
  readonly limit?: number;
}

export interface RunJournalFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /** Only entries with sequence >= this value. */
  readonly since?: number;
}

export interface RunJournalPage {
  readonly data: readonly unknown[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ListRunsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /** Only one project's runs (`kind: 'project'`), or the runs of every project in an org (`kind: 'org'`). */
  readonly scope?: ScopeRef;
  /** Only the child runs of this run. */
  readonly parentRunId?: RunId;
  /** Only runs that are not a child of another run. */
  readonly topLevel?: boolean;
  /** Only this agent's turns, at any version (turns from before 0.1.3 don't name their agent). */
  readonly agentId?: AgentId | string;
  /** Replay runs (an eval run re-running a past run): `exclude` (the default) leaves them out, `include` lists them too, `only` lists just them. */
  readonly replays?: 'exclude' | 'include' | 'only';
  /** Only the replay runs of this eval run (implies replays are included). */
  readonly evalRunId?: string;
  /** Only the runs this trigger started. */
  readonly triggerId?: string;
  /** Include each run's `output` (omitted from lists by default). */
  readonly includeOutput?: boolean;
}

export interface RunPage {
  readonly data: readonly Run[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/**
 * Discriminated on the identifier kind so the API layer knows whether
 * to run an agent or a flow. The SDK layer takes ids, as plain strings
 * (`'acme.triage-ticket'`) or branded ones; the API layer resolves them.
 */
export type StartRunInput =
  | {
      readonly agent: AgentId | string;
      /**
       * Omit to use the live version for this project and segment path
       * (or, in a conversation, the version its earlier turns used).
       */
      readonly agentVersion?: string;
      /** Project the run belongs to. Omit to use the tenant's default project. */
      readonly projectId?: string;
      /** Where the run happens, coarse to fine (e.g. company, then role); picks the live version. */
      readonly segments?: readonly ScopeSegment[];
      readonly input: unknown;
      readonly options?: StartRunOptions;
      readonly idempotencyKey?: string;
      /**
       * How long to wait for the answer, in milliseconds: this call's
       * `ClientOptions.timeoutMs`. A waited start answers only when the run
       * ends, so a run that can take longer is better started with
       * `options: { wait: false }` and followed.
       */
      readonly timeoutMs?: number;
    }
  | {
      readonly flow: FlowId | string;
      readonly flowVersion?: string;
      /** Project the run belongs to. Optional; when omitted, the API's run handler chooses. */
      readonly projectId?: string;
      /** Where the run happens; picks the live version of each agent step. */
      readonly segments?: readonly ScopeSegment[];
      readonly input: unknown;
      readonly options?: StartRunOptions;
      readonly idempotencyKey?: string;
      /**
       * How long to wait for the answer, in milliseconds: this call's
       * `ClientOptions.timeoutMs`. A waited start answers only when the run
       * ends, so a run that can take longer is better started with
       * `options: { wait: false }` and followed.
       */
      readonly timeoutMs?: number;
    };

export interface StartRunOptions {
  /** Run with side-effects mocked; the row is marked `dryRun: true`. */
  readonly dryRun?: boolean;
  /**
   * `false` → the server answers as soon as the run exists and finishes
   * it in the background; poll `get(runId)`. Default: wait for the run
   * to complete, fail or suspend.
   */
  readonly wait?: boolean;
}

export interface ResumeRunInput {
  readonly runId: RunId;
  readonly waitpointId: string;
  readonly value?: unknown;
  readonly idempotencyKey?: string;
}

/**
 * The agent a run is a turn of (`@kindgi/api/openapi.json#RunAgent`):
 * which agent, the version that ran, and the conversation.
 */
export interface RunAgent {
  readonly id: string;
  readonly version: string;
  readonly conversationId: string;
  /**
   * How the version was chosen: named on the run (`explicit`), held by the
   * flow version a flow's agent step runs in (`flow-pin`: the node's
   * `config.version`, else the flow version's pin), the conversation's
   * version (`conversation`), a live version (`live`), or the latest
   * (`latest`). Absent on turns from before 0.1.4.
   */
  readonly via?: 'explicit' | 'flow-pin' | 'conversation' | 'live' | 'latest';
  /** With `via: 'live'`: the scope whose live version ran. */
  readonly liveScope?: LiveScope;
}

/** Why a failed run failed. Matches `@kindgi/api/openapi.json#RunFailure`. */
export interface RunFailure {
  /** The error's own code, or `run-failed`. */
  readonly code: string;
  readonly message: string;
  /** What the error came from, when it says (e.g. the router's reasons). */
  readonly cause?: unknown;
}

/**
 * The trigger that started a run (`@kindgi/api/openapi.json#RunTrigger`):
 * the trigger, and the fire in its history that started the run.
 */
export interface RunTrigger {
  readonly triggerId: string;
  readonly kind: 'schedule' | 'event' | 'webhook';
  readonly fireId: string;
  /** A schedule's fire: the occurrence the run is for. */
  readonly scheduledFor?: Timestamp;
}

/**
 * Wire shape — matches `@kindgi/api/openapi.json#Run`. Runs are
 * flow-native on the wire: an agent run executes as a flow on the
 * server, and the row reports that flow's `flowId` / `flowVersion`;
 * `agent` names the agent.
 */
export interface Run {
  readonly id: RunId;
  readonly tenantId: TenantId;
  readonly projectId?: string;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly status: RunStatus;
  readonly dryRun: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly completedAt?: Timestamp;
  /** The failure as the runtime recorded it; read `failure` instead. */
  readonly failureMessage?: string;
  /**
   * Why a failed run failed: an agent turn's own error (`budget-exceeded`,
   * `capability-routing-failed`, …) or `run-failed`. Absent unless the run
   * is `failed`, and from runtimes before 0.1.5.
   */
  readonly failure?: RunFailure;
  /** The run's output once it completed. Lists carry it only with `includeOutput`. */
  readonly output?: unknown;
  /** Set on a child run: the run that started it. */
  readonly parentRunId?: RunId;
  /** Set on a child run: the node in the parent run that started it. */
  readonly parentNodeId?: string;
  /**
   * Set on an agent's turn (an agent run, or the turn a flow's agent step
   * started). Absent on other runs, and on turns from before 0.1.3.
   */
  readonly agent?: RunAgent;
  /** Set on a run a trigger started (a schedule, an event trigger, an inbound webhook). */
  readonly trigger?: RunTrigger;
  /** The segment path the run was started with; a child run has its parent's. */
  readonly segments?: readonly ScopeSegment[];
  /**
   * When an erasure cleared the run's content (its input, output, failure
   * message and journal payloads): a person's words were erased.
   */
  readonly contentErasedAt?: string;
  /**
   * The W3C trace id of the request that started the run (yours, when you
   * sent a `traceparent`). Absent for a run no request started, and from
   * an older runtime.
   */
  readonly traceId?: string;
}

/**
 * What `runs.start` returns: the run, plus a public run token when the
 * deployment issues them. Only the start response carries the token;
 * `get` and `list` never do.
 */
export interface StartedRun extends Run {
  /**
   * A short-lived, read-only token for this run and its descendants:
   * progress only (`GET /v1/runs/{runId}/progress` and its stream), for
   * a browser. Absent when the deployment issues no public run tokens.
   */
  readonly publicAccessToken?: string;
  /** When `publicAccessToken` stops working. */
  readonly publicAccessTokenExpiresAt?: Timestamp;
}

/**
 * A waited start that the client's timeout ended: the run may still be
 * going, and its id never arrived. Says how to start a long run instead.
 * Any other error is returned as it is.
 */
function waitedStartTimeout(e: unknown): unknown {
  if (!(e instanceof KindgiApiError) || e.error.code !== 'network') return e;
  const { timeoutMs } = e.error;
  if (timeoutMs === undefined) return e;
  return new KindgiApiError({
    code: 'network',
    message: `The run didn't end within ${seconds(timeoutMs)}, the client's timeout (timeoutMs). A waited start answers only when the run ends, so the run may still be going, and its id didn't arrive. Start a run that can take longer with \`options: { wait: false }\`: the answer carries its id at once. Then follow it with \`runs.stream(runId)\` or \`runs.get(runId)\`. Or raise \`timeoutMs\`.`,
    cause: e.error.cause,
    timeoutMs,
  });
}

export function makeRunsClient(transport: Transport): RunsClient {
  // `follow` / `followProgress`, and the deprecated `stream` /
  // `streamProgress`, which do the same (a method may be called unbound).
  const followEvents: RunsClient['follow'] = (runId, options) =>
    followRun<RunEvent>({
      url: `${transport.apiUrl}/v1/runs/${encodeURIComponent(runId as unknown as string)}/stream`,
      headers: () => transport.authHeaders(),
      fetchImpl: transport.fetchImpl,
      ...(options?.signal !== undefined && { signal: options.signal }),
      ...(options?.initialBackoffMs !== undefined && {
        initialBackoffMs: options.initialBackoffMs,
      }),
      ...(options?.maxBackoffMs !== undefined && {
        maxBackoffMs: options.maxBackoffMs,
      }),
    });
  const followProgressEvents: RunsClient['followProgress'] = (runId, options) =>
    followRun<RunProgressEvent>({
      url: `${transport.apiUrl}/v1/runs/${encodeURIComponent(runId as unknown as string)}/progress/stream`,
      headers: () => transport.authHeaders(),
      fetchImpl: transport.fetchImpl,
      ...(options?.signal !== undefined && { signal: options.signal }),
      ...(options?.initialBackoffMs !== undefined && {
        initialBackoffMs: options.initialBackoffMs,
      }),
      ...(options?.maxBackoffMs !== undefined && {
        maxBackoffMs: options.maxBackoffMs,
      }),
    });

  return {
    async start(input) {
      const body: Record<string, unknown> =
        'agent' in input
          ? {
              agent: input.agent as unknown as string,
              ...(input.agentVersion !== undefined && { agentVersion: input.agentVersion }),
              ...(input.projectId !== undefined && { projectId: input.projectId }),
              ...(input.segments !== undefined && { segments: input.segments }),
              input: input.input,
              ...(input.options !== undefined && { options: input.options }),
            }
          : {
              flow: input.flow as unknown as string,
              ...(input.flowVersion !== undefined && { flowVersion: input.flowVersion }),
              ...(input.projectId !== undefined && { projectId: input.projectId }),
              ...(input.segments !== undefined && { segments: input.segments }),
              input: input.input,
              ...(input.options !== undefined && { options: input.options }),
            };
      try {
        return await transport.request<StartedRun>({
          method: 'POST',
          path: '/v1/runs',
          body,
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: input.idempotencyKey,
          }),
          ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
        });
      } catch (e) {
        throw input.options?.wait === false ? e : waitedStartTimeout(e);
      }
    },

    async dryRun(_input) {
      throw new KindgiApiError(
        notYetWired(
          'runs.dryRun',
          'no dedicated dry-run route on the API — use runs.start({ ..., options: { dryRun: true } }); the design-drafted DryRunResult (planned nodes / cost estimate) is a distinct preview primitive that has no wire route yet',
        ),
      );
    },

    async progress(runId) {
      return transport.request<RunProgress>({
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(runId as unknown as string)}/progress`,
      });
    },

    followProgress: followProgressEvents,

    follow: followEvents,

    streamProgress: followProgressEvents,

    stream: followEvents,

    async get(runId) {
      return transport.request<Run>({
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(runId as unknown as string)}`,
      });
    },

    async resume(input) {
      return transport.request<Run>({
        method: 'POST',
        path: `/v1/runs/${encodeURIComponent(input.runId as unknown as string)}/resume`,
        body: {
          waitpointId: input.waitpointId,
          ...(input.value !== undefined && { value: input.value }),
        },
        ...(input.idempotencyKey !== undefined && {
          idempotencyKey: input.idempotencyKey,
        }),
      });
    },

    async cancel(runId, options) {
      return transport.request<Run>({
        method: 'POST',
        path: `/v1/runs/${encodeURIComponent(runId as unknown as string)}/cancel`,
        body: {},
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    async list(filter) {
      return transport.request<RunPage>({
        method: 'GET',
        path: '/v1/runs',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.scope !== undefined && scopeToQuery(filter.scope)),
          ...(filter?.parentRunId !== undefined && {
            parentRunId: filter.parentRunId as unknown as string,
          }),
          ...(filter?.topLevel !== undefined && { topLevel: String(filter.topLevel) }),
          ...(filter?.agentId !== undefined && { agentId: filter.agentId as string }),
          ...(filter?.replays !== undefined && { replays: filter.replays }),
          ...(filter?.evalRunId !== undefined && { evalRunId: filter.evalRunId }),
          ...(filter?.triggerId !== undefined && { triggerId: filter.triggerId }),
          ...(filter?.includeOutput === true && { include: 'output' }),
        },
      });
    },

    async journal(runId, filter) {
      return transport.request<RunJournalPage>({
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(runId as unknown as string)}/journal`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.since !== undefined && { since: filter.since }),
        },
      });
    },

    async failures(query) {
      const at = (t: Date | string) => (t instanceof Date ? t.toISOString() : t);
      return transport.request<RunFailureGroups>({
        method: 'GET',
        path: '/v1/runs/failures',
        query: {
          projectId: query.projectId,
          from: at(query.from),
          to: at(query.to),
          ...(query.agentId !== undefined && { agentId: query.agentId as string }),
          ...(query.flowId !== undefined && { flowId: query.flowId as string }),
          ...(query.groupBy !== undefined && { groupBy: query.groupBy.join(',') }),
          ...(query.limit !== undefined && { limit: query.limit }),
        },
      });
    },
  };
}
