// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export interface PersistenceError {
  readonly code: 'persistence-error';
  readonly message: string;
  readonly cause?: unknown;
}

export interface InvalidCursorError {
  readonly code: 'invalid-cursor';
  readonly message: string;
}

/**
 * Rejected on `append` when an event fails schema validation before
 * write. `issues` is the per-path breakdown from the underlying
 * validator. Exported as `AuditEventValidationError` to disambiguate
 * from `@kindgi/schema.ValidationError` (a different shape used for
 * JSON schema validation failures at the type-registry boundary).
 */
export interface AuditEventValidationError {
  readonly code: 'invalid-event';
  readonly message: string;
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
}

export type AuditEventError = PersistenceError | InvalidCursorError | AuditEventValidationError;
