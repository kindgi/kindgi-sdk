// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FlowId, ProvenanceId, Result, RunId, TenantId, Timestamp } from '@kindgi/types';

import type { ProvenanceError } from './errors.js';
import { signProvenance } from './sign.js';
import type { KeyProvider, Provenance, ProvenanceEdge, ProvenanceNode } from './types.js';

/**
 * Incremental builder for a run's provenance DAG.
 *
 * Callers `addNode` / `addEdge` as a run's work executes; at run end,
 * `finalize(keyProvider)` produces a signed `Provenance` ready to hand to
 * a `ProvenanceEmitBinding`.
 *
 * Not tenant-scoped internally — the tenantId set at construction is
 * embedded in the final record. Not thread-safe; callers hold one builder
 * per run and don't share it across concurrent runs.
 */
export interface ProvenanceBuilder {
  readonly id: ProvenanceId;
  readonly runId: RunId;
  readonly tenantId: TenantId;
  addNode(node: ProvenanceNode): void;
  addEdge(edge: ProvenanceEdge): void;
  /** Snapshot the current DAG without signing. Useful for tests and debugging. */
  snapshot(): Provenance;
  /** Sign + return the final Provenance record. */
  finalize(keyProvider: KeyProvider): Result<Provenance, ProvenanceError>;
}

export interface BuilderOptions {
  readonly id: ProvenanceId;
  readonly runId: RunId;
  readonly tenantId: TenantId;
  /** Optional flow the run executed. Recorded on the final Provenance. */
  readonly flowRef?: { readonly id: FlowId; readonly version: string };
  /** Provenance schema version. Defaults to '1.0.0'. */
  readonly version?: string;
  /**
   * Override the createdAt timestamp. Rarely useful outside tests where
   * a deterministic timestamp is needed for signature stability across runs.
   */
  readonly createdAt?: Timestamp;
}

export function newBuilder(options: BuilderOptions): ProvenanceBuilder {
  const nodes: ProvenanceNode[] = [];
  const edges: ProvenanceEdge[] = [];
  const createdAt = options.createdAt ?? (new Date().toISOString() as Timestamp);

  function snap(): Provenance {
    return {
      id: options.id,
      runId: options.runId,
      tenantId: options.tenantId,
      version: options.version ?? '1.0.0',
      createdAt,
      ...(options.flowRef !== undefined && { flowRef: options.flowRef }),
      nodes: [...nodes],
      edges: [...edges],
    };
  }

  return {
    id: options.id,
    runId: options.runId,
    tenantId: options.tenantId,
    addNode(node): void {
      nodes.push(node);
    },
    addEdge(edge): void {
      edges.push(edge);
    },
    snapshot(): Provenance {
      return snap();
    },
    finalize(keyProvider): Result<Provenance, ProvenanceError> {
      return signProvenance(snap(), keyProvider);
    },
  };
}
