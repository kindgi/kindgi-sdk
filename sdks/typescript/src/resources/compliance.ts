// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Compliance — SOC 2 evidence readback + export.
 *
 * @wire /v1/compliance/evidence/*  (packages/api/src/routes/compliance.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Evidence is emitted by the framework's compliance pipeline as a
 * side-effect of privileged operations (secret writes, deploy syncs,
 * capability changes, etc.). This resource is read-only + export.
 */

import type {
  ComplianceEvidence,
  ComplianceEvidenceCollectionPage,
  EvidenceKind,
  ExportComplianceEvidenceBody,
  SignedComplianceEvidenceBundle,
} from '../generated/api.js';
import type { Transport } from '../transport.js';
import { type SignedExportVerification, verifySignedExport } from '../verify-export.js';

export type Evidence = ComplianceEvidence;
export type EvidencePage = ComplianceEvidenceCollectionPage;
export type EvidenceExportInput = ExportComplianceEvidenceBody;
export type EvidenceExportBundle = SignedComplianceEvidenceBundle;

export interface ListEvidenceFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly flowId?: string;
  readonly kind?: EvidenceKind;
  readonly from?: string;
  readonly to?: string;
}

export interface ComplianceClient {
  readonly evidence: EvidenceClient;
}

export interface EvidenceClient {
  /** @wire GET /v1/compliance/evidence */
  list(filter?: ListEvidenceFilter): Promise<EvidencePage>;
  /** @wire GET /v1/compliance/evidence/:evidenceId */
  get(evidenceId: string): Promise<Evidence>;
  /**
   * Export a signed evidence bundle over a time + subject filter.
   * @wire POST /v1/compliance/evidence/export
   */
  export(
    input: EvidenceExportInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<EvidenceExportBundle>;
  /**
   * Verify an evidence bundle where it's read (Web Crypto's Ed25519; no
   * request): its signature over the bytes shipped, and that it was
   * signed with `publicKey`, a key you trust.
   */
  verify(bundle: EvidenceExportBundle, publicKey: string): Promise<SignedExportVerification>;
}

export function makeComplianceClient(transport: Transport): ComplianceClient {
  return {
    evidence: {
      async list(filter) {
        return transport.request<EvidencePage>({
          method: 'GET',
          path: '/v1/compliance/evidence',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.runId !== undefined && { runId: filter.runId }),
            ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
            ...(filter?.flowId !== undefined && { flowId: filter.flowId }),
            ...(filter?.kind !== undefined && { kind: filter.kind }),
            ...(filter?.from !== undefined && { from: filter.from }),
            ...(filter?.to !== undefined && { to: filter.to }),
          },
        });
      },
      async get(evidenceId) {
        return transport.request<Evidence>({
          method: 'GET',
          path: `/v1/compliance/evidence/${encodeURIComponent(evidenceId)}`,
        });
      },
      async export(input, options) {
        return transport.request<EvidenceExportBundle>({
          method: 'POST',
          path: '/v1/compliance/evidence/export',
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      verify: (bundle, publicKey) => verifySignedExport(bundle, { trustedKeys: [publicKey] }),
    },
  };
}
