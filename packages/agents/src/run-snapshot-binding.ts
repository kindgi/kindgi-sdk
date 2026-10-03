// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, Result, RunId, Semver, TenantId, Timestamp } from '@kindgi/types';

import type { PersistenceError } from './errors.js';
import type { AgentId, ConversationId } from './types.js';

/**
 * Input for `RunSnapshotBinding.write` — the InvokeAgentInput envelope
 * captured at run-start so `resumeAgentTurn(runId)` can rebuild the
 * same TurnContext after a kernel waitpoint resolves. Idempotent under
 * flow replay via the runId primary key.
 */
export interface RunSnapshotWriteInput {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
  readonly agentVersion: Semver;
  readonly conversationId: ConversationId;
  readonly userMessage: string;
  /** The turn's prompt parameters — a resumed turn renders its instructions with them. */
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
  /** The turn's structured input (`InvokeAgentInput.input`); same persistence contract. */
  readonly input?: unknown;
  readonly participantId?: string;
  readonly dryRun?: boolean;
  /**
   * Optional serialized Principal (authorization). Impls MUST persist
   * unchanged and return it verbatim from `read` so resumed turns get
   * the same enforcement context. Wire shape is opaque to this layer.
   */
  readonly principal?: unknown;
  /**
   * Optional authz config (`{ fgaApiUrl }`). Same persistence contract
   * as `principal`.
   */
  readonly authz?: unknown;
}

/**
 * Persisted run-snapshot row returned by `RunSnapshotBinding.read`.
 * Field shape mirrors the `agent_run_snapshots` table but is expressed
 * as a plain interface so alternative impls (non-Postgres) match the
 * same contract.
 */
export interface RunSnapshotRecord {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
  readonly agentVersion: Semver;
  readonly conversationId: ConversationId;
  readonly userMessage: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
  readonly input?: unknown;
  readonly participantId?: string;
  readonly dryRun: boolean;
  readonly principal?: unknown;
  readonly authz?: unknown;
  readonly createdAt: Timestamp;
}

/**
 * `RunSnapshotBinding` — the public seam between @kindgi/agents and
 * whatever run-snapshot store a deployment plugs in (the Kindgi
 * runtime ships a Postgres-backed one; alternatives possible).
 *
 * Ownership: @kindgi/agents (not the kernel). Kernel schemas stay
 * generic across all flow runners; agent-specific reconstruction
 * context lives at this layer.
 *
 * `write` is best-effort — a failure does NOT fail the turn (the run
 * already started; snapshot-write hiccups shouldn't block execution).
 * Callers of a resumed turn get `run-snapshot-missing` and know the
 * run is unrecoverable. Impls MUST be idempotent under kernel replay
 * (ON CONFLICT DO NOTHING on the runId PK, or equivalent).
 */
export interface RunSnapshotBinding {
  write(input: RunSnapshotWriteInput): Promise<Result<void, PersistenceError>>;

  read(
    tenantId: TenantId,
    runId: RunId,
  ): Promise<Result<RunSnapshotRecord | null, PersistenceError>>;
}
