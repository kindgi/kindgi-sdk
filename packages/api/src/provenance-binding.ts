// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Provenance binding surface — types + `ProvenanceBinding` interface
// consumed by the provenance routes. Deployments plug in an
// implementation (the Kindgi runtime provides one); @kindgi/api never
// touches provenance storage directly.
//

import type { FlowId, ProvenanceId, Result, RunId, TenantId, Timestamp } from '@kindgi/types';

// ---------- domain type surface ----------

export const NODE_KINDS = [
  'input',
  'prompt',
  'retrieval',
  'tool-call',
  'tool-result',
  'model-call',
  'model-output',
  'artifact',
  'guardrail-check',
  'event',
  'policy-decision',
  'memory-read',
  'memory-write',
  'wait',
  'resume',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  'caused-by',
  'influenced-by',
  'retrieved-from',
  'invoked',
  'produced',
  'checked-against',
  'waited-on',
  'resumed-from',
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface ProvenanceNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly timestamp: Timestamp;
  readonly actor?: string;
  readonly contentHash?: string;
  readonly contentRef?: string;
  readonly modelVersion?: string;
  readonly policyDecisionId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface ProvenanceEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

export interface Signature {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly value: string;
  readonly signedAt: Timestamp;
}

export interface Provenance {
  readonly id: ProvenanceId;
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly version: string;
  readonly createdAt: Timestamp;
  readonly flowRef?: { readonly id: FlowId; readonly version: string };
  readonly nodes: readonly ProvenanceNode[];
  readonly edges: readonly ProvenanceEdge[];
  readonly signature?: Signature;
}

// ---------- method inputs / outputs ----------

/**
 * Keyset cursor for `listRecords`. Decoded shape — routes handle the
 * base64 encoding envelope (`./routes/pagination.ts`). Binding consumers
 * pass the decoded pair through so the binding never touches route-layer
 * encoding conventions.
 */
export interface ProvenanceListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListProvenanceRecordsInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly runId?: RunId;
  readonly agentId?: string;
  readonly createdAfter?: Date;
  readonly cursor?: ProvenanceListCursor;
}

/**
 * Denormalized record metadata used by `GET /v1/provenance` list. Full
 * DAG (`nodes`, `edges`) is fetched only via `getByRunId` — list only
 * exposes summary rows.
 */
export interface ProvenanceRecordSummary {
  readonly id: ProvenanceId;
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly version: string;
  readonly createdAt: Timestamp;
  readonly flowRef?: { readonly id: FlowId; readonly version: string };
  readonly signed: boolean;
}

export interface ListProvenanceRecordsResult {
  readonly records: readonly ProvenanceRecordSummary[];
  readonly nextCursor?: ProvenanceListCursor;
}

// ---------- error shape ----------

/**
 * Structural error surface returned by `ProvenanceBinding` methods.
 * Implementations emit codes `provenance-not-found` + `persistence-error`
 * — the routes pass them through to `statusFor()` / `toWireError()`.
 */
export interface ProvenanceBindingError {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

// ---------- binding ----------

/**
 * Provenance data-access binding. Every method takes typed inputs and
 * returns `Promise<Result<T, ProvenanceBindingError>>` — the
 * implementation owns its storage client, so callers never touch
 * storage directly.
 */
export interface ProvenanceBinding {
  /**
   * List provenance records, keyset-paginated by
   * `(createdAt desc, id desc)`. Optional filters narrow by run, agent
   * (node actor), and creation window. Returns already-shaped
   * `ProvenanceRecordSummary` rows — the binding owns the storage →
   * wire projection.
   *
   * The result carries `nextCursor` when more records exist; the route
   * derives `hasMore` from it and encodes it as the next cursor.
   */
  listRecords(
    input: ListProvenanceRecordsInput,
  ): Promise<Result<ListProvenanceRecordsResult, ProvenanceBindingError>>;

  /**
   * Reconstruct the full provenance DAG for a run. Returns
   * `provenance-not-found` (via `code`) when no record exists for the
   * tenant/run pair.
   */
  getByRunId(tenantId: TenantId, runId: RunId): Promise<Result<Provenance, ProvenanceBindingError>>;
}
