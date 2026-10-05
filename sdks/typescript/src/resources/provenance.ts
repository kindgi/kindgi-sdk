// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor, Page, RunId, Timestamp } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { scopeToQuery } from '../scope-wire.js';
import type { Transport } from '../transport.js';
import type {
  ExportedProvenance,
  ProvenanceQueryFilter,
  ProvenanceRecord,
  ProvenanceRecordMetadata,
  ProvenanceVerifyResult,
} from '../types.js';

/**
 * Provenance resource — read + export + verify the causal DAG
 * recorded for each run.
 *
 * `get`, `query` and `export` call API routes. `verify` is a
 * client-side operation, and the SDK does not bundle an Ed25519
 * verifier, so it throws `not-yet-wired`.
 */
export interface ProvenanceClient {
  /**
   * Fetch the full provenance DAG for a run.
   *
   * @wire `GET /v1/provenance/{runId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1provenance~1{runId}/get`.
   */
  get(runId: RunId): Promise<ProvenanceRecord>;

  /**
   * List provenance records (metadata only — DAG payload omitted for
   * pagination performance; callers fetch the DAG via `get(runId)`).
   *
   * @wire `GET /v1/provenance` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1provenance/get`.
   */
  query(filter?: ProvenanceQueryFilter): Promise<Page<ProvenanceRecordMetadata>>;

  /**
   * Export a signed JSON bundle for a run. The server canonicalizes the
   * DAG + optional messages, signs with the Ed25519 key named by
   * `signingKeyId`, and returns the envelope. Deployments without a
   * signing-key binding return `404 signing-not-configured`; an unknown
   * key id returns `404 signing-key-not-found`.
   *
   * @wire `POST /v1/provenance/{runId}/export` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1provenance~1{runId}~1export/post`.
   */
  export(input: ProvenanceExportInput): Promise<ExportedProvenance>;

  /**
   * @unwired Client-side Ed25519 verification is not bundled in the
   *   SDK (`verifyEd25519` lives in `@kindgi/crypto`). Throws
   *   `KindgiApiError` with `code: 'not-yet-wired'`.
   */
  verify(exported: ExportedProvenance, publicKey: string): Promise<ProvenanceVerifyResult>;
}

export interface ProvenanceExportInput {
  /** Target run. */
  readonly runId: RunId;
  /** Signing key id (looked up in the deployment's `SigningKeyBinding`). */
  readonly signingKeyId: string;
  /**
   * When `true`, the exported bundle includes the run's conversation
   * messages. Defaults to `false`; setting `true` on a flow-only run
   * yields an empty `messages: []` field.
   */
  readonly includeMessages?: boolean;
  /** Optional caller idempotency key. */
  readonly idempotencyKey?: string;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export function makeProvenanceClient(transport: Transport): ProvenanceClient {
  return {
    async get(runId) {
      return transport.request<ProvenanceRecord>({
        method: 'GET',
        path: `/v1/provenance/${encodeURIComponent(runId as unknown as string)}`,
      });
    },

    async query(filter) {
      const page = await transport.request<WirePage<ProvenanceRecordMetadata>>({
        method: 'GET',
        path: '/v1/provenance',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.scope !== undefined && scopeToQuery(filter.scope)),
          ...(filter?.runId !== undefined && { runId: filter.runId as unknown as string }),
          ...(filter?.agentId !== undefined && {
            agentId: filter.agentId as unknown as AgentId as unknown as string,
          }),
          ...(filter?.createdAfter !== undefined && {
            createdAfter: filter.createdAfter as unknown as Timestamp as unknown as string,
          }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
      };
    },

    async export(input) {
      return transport.request<ExportedProvenance>({
        method: 'POST',
        path: `/v1/provenance/${encodeURIComponent(input.runId as unknown as string)}/export`,
        body: {
          signingKeyId: input.signingKeyId,
          ...(input.includeMessages !== undefined && { includeMessages: input.includeMessages }),
        },
        ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      });
    },

    async verify(_exported, _publicKey) {
      throw new KindgiApiError(
        notYetWired(
          'provenance.verify',
          'client-side ed25519 verification requires the crypto module subpackage to be reachable from the SDK',
        ),
      );
    },
  };
}
