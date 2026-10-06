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
} from '@kindgi/types';

import type { RunAgentRef } from './inputs.js';
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
}

export interface ListRunsPage {
  readonly data: readonly KernelRunRecord[];
  readonly nextCursor?: Cursor;
}
