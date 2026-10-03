// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, Result, SigningKeyId } from '@kindgi/types';

import type { Evidence } from './types.js';

/**
 * Errors emitted by the compliance surface. Every variant carries a `code`
 * for pattern matching; messages are human-readable, not API contract.
 */
export type ComplianceError =
  | InvalidEvidenceError
  | PersistenceError
  | SignerFailureError
  | SigningKeyMissingError
  | SigningFailureError
  | InvalidCursorError
  | ProjectNotFoundError
  | UnsupportedVersionError;

/**
 * Structural validation of an evidence record against the compliance
 * schema failed — e.g. `generator.recordFromRun` assembled a record that
 * doesn't match the wire schema. A caller-shape bug or a schema drift,
 * never a persistence issue.
 */
export interface InvalidEvidenceError {
  readonly code: 'invalid-evidence';
  readonly message: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/**
 * The caller-plugged persistence binding threw or returned an error.
 */
export interface PersistenceError {
  readonly code: 'persistence-error';
  readonly message: string;
  readonly cause: unknown;
}

/**
 * A caller-plugged `EvidenceSigner` function threw. Distinct from
 * `SigningFailureError` (which is specific to the generator's own
 * Ed25519 signing path, e.g. `exportSigned`) so callers can distinguish
 * the two signing paths.
 */
export interface SignerFailureError {
  readonly code: 'signer-failure';
  readonly message: string;
  readonly cause: unknown;
}

/**
 * The caller asked for a signed export but the requested `SigningKeyId`
 * has no material in the mounted `SigningKeyBinding`. Typically a
 * misconfiguration.
 */
export interface SigningKeyMissingError {
  readonly code: 'signing-key-missing';
  readonly message: string;
  readonly signingKeyId: SigningKeyId;
}

/**
 * The Ed25519 signing primitive itself rejected the material — malformed
 * key bytes, wrong length, or an underlying primitive that refused the
 * input.
 */
export interface SigningFailureError {
  readonly code: 'signing-failure';
  readonly message: string;
  readonly signingKeyId: SigningKeyId;
  readonly cause: unknown;
}

/**
 * An evidence listing received a `cursor` that isn't decodable to a
 * `(timestamp, id)` pair. Almost always a client bug.
 */
export interface InvalidCursorError {
  readonly code: 'invalid-cursor';
  readonly message: string;
}

/**
 * An evidence write (`recordFromRun`, `ComplianceProvider.emit`) named a
 * `projectId` that doesn't exist inside the tenant. Distinct from
 * `PersistenceError` so the API layer can map the caller-shape bug to a
 * 404 wire response rather than 500.
 */
export interface ProjectNotFoundError {
  readonly code: 'project-not-found';
  readonly message: string;
  readonly projectId: ProjectId;
}

/**
 * A record read from storage carried a `payload.version` newer than this
 * reader knows how to normalize — typically during a rolling deploy.
 */
export interface UnsupportedVersionError {
  readonly code: 'unsupported-version';
  readonly message: string;
  readonly version: number;
  readonly evidenceId: string;
}

export type EmitResult = Result<Evidence, ComplianceError>;
export type ListResult = Result<readonly Evidence[], ComplianceError>;
