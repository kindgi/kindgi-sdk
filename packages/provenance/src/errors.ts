// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProvenanceId, RunId, TenantId } from '@kindgi/types';

/**
 * Errors emitted by @kindgi/provenance. Every variant carries a `code`
 * for pattern matching; messages are human-readable, not API contract.
 */
export type ProvenanceError =
  | InvalidProvenanceError
  | UnknownKeyError
  | SigningNotSupportedError
  | SignatureVerificationError
  | MissingSignatureError
  | PersistenceError
  | ProvenanceNotFoundError;

/** Structural validation failed against provenance.schema.json. */
export interface InvalidProvenanceError {
  readonly code: 'invalid-provenance';
  readonly message: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/** A signature references a keyId the provider does not know. */
export interface UnknownKeyError {
  readonly code: 'unknown-key';
  readonly message: string;
  readonly keyId: string;
}

/**
 * The resolved key has no private material — the provider is verification-only
 * for this key. Attempted signing is a caller mistake.
 */
export interface SigningNotSupportedError {
  readonly code: 'signing-not-supported';
  readonly message: string;
  readonly keyId: string;
  readonly tenantId?: TenantId;
}

/**
 * The signature bytes did not verify against the canonical serialization
 * + public key. Almost always means tampering; occasionally a key mismatch.
 */
export interface SignatureVerificationError {
  readonly code: 'signature-verification-failed';
  readonly message: string;
  readonly keyId: string;
}

/** verifyProvenance was called on a DAG without a signature attached. */
export interface MissingSignatureError {
  readonly code: 'missing-signature';
  readonly message: string;
  readonly provenanceId: ProvenanceId;
}

/** Storage read/write failed at the DB layer. */
export interface PersistenceError {
  readonly code: 'persistence-error';
  readonly message: string;
  readonly cause: unknown;
}

/** A provenance lookup by `runId` found no persisted record. */
export interface ProvenanceNotFoundError {
  readonly code: 'provenance-not-found';
  readonly message: string;
  readonly runId: RunId;
}
