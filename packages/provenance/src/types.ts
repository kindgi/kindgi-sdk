// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FlowId, ProvenanceId, RunId, TenantId, Timestamp } from '@kindgi/types';

/** Closed set of node kinds — matches @kindgi/specs/provenance.schema.json. */
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

/** Closed set of edge kinds. */
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

/**
 * One node in the causal DAG. Nodes are content-addressed via `contentHash`
 * so a payload change tampers the hash — pair with the record-level
 * signature and the whole DAG is tamper-evident.
 *
 * `contentRef` (blob://...) lets large payloads (full model outputs, long
 * documents) live outside the DAG record while their hash stays inline
 * for verification.
 */
export interface ProvenanceNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly timestamp: Timestamp;
  readonly actor?: string;
  readonly contentHash?: string;
  readonly contentRef?: string;
  /**
   * Model + version for model-call / model-output nodes. Convention:
   * `<provider>/<model>`, optionally suffixed `@<date-or-version>`
   * (e.g. `acme-llm/acme-large@2026-06-01`).
   */
  readonly modelVersion?: string;
  /** For policy-decision nodes: id resolving to the full decision record. */
  readonly policyDecisionId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** One edge in the causal DAG. */
export interface ProvenanceEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

/** Ed25519 signature over the canonical serialization of the DAG (minus signature). */
export interface Signature {
  readonly algorithm: 'ed25519';
  /** Identifier of the signing key — enables key rotation without breaking existing signatures. */
  readonly keyId: string;
  /** Base64-encoded signature bytes. */
  readonly value: string;
  readonly signedAt: Timestamp;
}

/**
 * A signed provenance record — one DAG per run. Immutable once written;
 * queries return this shape reconstructed from storage.
 */
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

/**
 * A key resolvable by the KeyProvider. Public key is always required (for
 * verification); private key is only present when signing is supported.
 * `keyId` is the identifier embedded in emitted signatures.
 */
export interface KeyMaterial {
  readonly keyId: string;
  /** Ed25519 public key, base64-encoded DER (SPKI). */
  readonly publicKey: string;
  /**
   * Ed25519 private key, base64-encoded DER (PKCS#8).
   * Absent for verification-only providers (e.g. verifying an exported
   * DAG using only the deployment's public key).
   */
  readonly privateKey?: string;
}

/**
 * Hybrid key resolution: per-tenant key wins if present, otherwise
 * deployment key is used. `keyId` records which was chosen. The provider
 * exposes both `signingKey` (must have a private key) and `verificationKey`
 * (public key sufficient) so callers can operate in verification-only mode
 * without the private material.
 */
export interface KeyProvider {
  /** Return the key to use for signing for this tenant. */
  signingKey(tenantId: TenantId): KeyMaterial;
  /**
   * Return the key that matches a `keyId` from an existing signature. Used
   * by `verifyProvenance` — the verifier only needs the public key.
   */
  verificationKey(keyId: string): KeyMaterial | undefined;
  /** Return the deployment key material (public part guaranteed). */
  deploymentKey(): KeyMaterial;
  /** Describe this provider — name, version, and one-line summary. */
  describe(): { readonly name: string; readonly version: string; readonly description: string };
}
