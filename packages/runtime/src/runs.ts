// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// KernelRunRecord + list/get shapes — the public projection of a run
// that RunBinding exposes. Deliberately narrower than what an
// implementation stores: bookkeeping such as retention or cache markers
// is not part of this shape.
//

import type { FlowVersionOverrides } from '@kindgi/flow';
import type {
  Cursor,
  NodeId,
  OrgId,
  ProjectId,
  RunId,
  ScopeSegment,
  TenantId,
  Timestamp,
  TriggerId,
} from '@kindgi/types';

import type { RunAgentRef, RunTriggerRef } from './inputs.js';
import type { RunStatus } from './types.js';

/**
 * Public run shape exposed by `RunBinding.getRun` / `.listRuns`.
 * Matches the fields @kindgi/api's `/v1/runs` routes serialize to
 * the wire.
 */
export interface KernelRunRecord {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly status: RunStatus;
  readonly input: unknown;
  /** The run's output once it completed — the value itself, not a storage envelope. */
  readonly output?: unknown;
  readonly failureMessage?: string | null;
  readonly dryRun: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly completedAt?: Timestamp | null;
  /** Set on a child run: the parent run and the node that started it (`ParentRunRef`). */
  readonly parentRunId?: RunId | null;
  readonly parentNodeId?: NodeId | null;
  readonly parentScope?: string | null;
  /**
   * The agent an agent turn's run is for (`RunAgentRef`). Absent on
   * every other run, and on agent runs started before runs recorded it.
   */
  readonly agent?: RunAgentRef;
  /** Set on a replay run: the run it re-ran and the eval run that did so (`RunReplayRef`). */
  readonly replayOf?: RunId | null;
  readonly evalRunId?: string | null;
  /**
   * The versions the run swaps in over its flow version's pins
   * (`RunFlowInput.versions`). Absent on a run that has none.
   */
  readonly versions?: FlowVersionOverrides;
  /**
   * The segment path the run was started with (ordered, coarse to fine),
   * which picks live agent versions: the run's own, and its agent steps'
   * when it is a flow run. Absent when it was started without one.
   */
  readonly segments?: readonly ScopeSegment[];
  /** Set on a run a trigger started (`RunTriggerRef`). */
  readonly trigger?: RunTriggerRef;
  /**
   * When an erasure cleared the run's content (its input, output, failure
   * message and journal payloads). Absent on every other run.
   */
  readonly contentErasedAt?: Timestamp;
  /**
   * The W3C trace id of the request that started the run
   * (`RunFlowInput.traceId`). Absent for a run no request started, and on
   * runs from before runs recorded it.
   */
  readonly traceId?: string | null;
}

/**
 * Content-scope filter for `RunBinding.listRuns`. Present-with-value
 * narrows to a specific project or org; absent = tenant-wide (admin
 * default). An org scope includes the runs of every project in that
 * org.
 */
export type RunListScope =
  | { readonly kind: 'project'; readonly projectId: ProjectId }
  | { readonly kind: 'org'; readonly orgId: OrgId };

/**
 * Cursor position for `RunBinding.listRuns`. Sort key is
 * `(createdAt desc, id desc)` — same discipline as every other
 * kernel-facing list. Callers pass the opaque `Cursor` string
 * decoded from the wire; the impl decodes it back to
 * `{ createdAt, id }` internally.
 */
export interface RunListCursor {
  /**
   * The last run's `createdAt`, as the binding's `nextCursor` carries it:
   * as stored (Postgres keeps microseconds). A binding compares it as given,
   * never through a JS `Date`, which keeps milliseconds and would skip the
   * runs created earlier in the same millisecond.
   */
  readonly createdAt: Timestamp;
  readonly id: RunId;
}

export interface ListRunsInput {
  readonly tenantId: TenantId;
  readonly scope?: RunListScope;
  readonly limit?: number;
  readonly cursor?: RunListCursor;
  /**
   * Only the children of this run — optionally only those a given node
   * (and loop scope) started.
   */
  readonly parent?: {
    readonly runId: RunId;
    readonly nodeId?: NodeId;
    readonly scope?: string;
  };
  /** Only runs that are not a child of another run. */
  readonly topLevelOnly?: boolean;
  /** Only the turns of this agent (`RunAgentRef.id`), at any version. */
  readonly agentId?: string;
  /** Replay runs: `exclude` leaves them out, `only` returns just them. Absent = include, so internal callers see every run. */
  readonly replays?: 'exclude' | 'include' | 'only';
  /** Only the replays of this eval run. */
  readonly evalRunId?: string;
  /** Only the runs this trigger started (`RunTriggerRef.triggerId`). */
  readonly triggerId?: TriggerId;
  /** Only runs in one of these statuses. */
  readonly statuses?: readonly RunStatus[];
  /** Only runs created strictly after this time. */
  readonly createdAfter?: Timestamp;
  /** Only runs created strictly before this time. */
  readonly createdBefore?: Timestamp;
  /** With `agentId`: only the turns that ran this version. Turns from before versions were recorded never match. */
  readonly agentVersion?: string;
  /** Only runs of this flow (an agent's turns run `agent.turn`). */
  readonly flowId?: string;
  /** With `flowId`: only runs of this version. */
  readonly flowVersion?: string;
}

export interface ListRunsPage {
  readonly data: readonly KernelRunRecord[];
  readonly nextCursor?: Cursor;
}
