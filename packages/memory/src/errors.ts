// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EmbeddingError } from '@kindgi/embedding';
import type { FactId, LogEntryId } from '@kindgi/types';

/**
 * Errors emitted by the memory subsystem. Every variant carries a `code`
 * for pattern matching; messages are human-readable, not API contract.
 *
 * `EmbeddingError` from @kindgi/embedding is folded in — an
 * implementation that embeds facts on write, and `searchBySemantic`,
 * resolve providers via the registry and may surface any of its
 * rejection modes (no-embedding-provider, unknown-embedding-model,
 * ambiguous-default-provider).
 */
export type MemoryError =
  | InvalidLogEntryError
  | InvalidFactError
  | FactNotFoundError
  | LogNotFoundError
  | EmbeddingError
  | RefreshHandlerMissingError
  | RetentionViolationError
  | PersistenceError;

export interface InvalidLogEntryError {
  readonly code: 'invalid-log-entry';
  readonly message: string;
  readonly reason: string;
}

export interface InvalidFactError {
  readonly code: 'invalid-fact';
  readonly message: string;
  readonly reason: string;
}

export interface FactNotFoundError {
  readonly code: 'fact-not-found';
  readonly message: string;
  readonly factId: FactId;
}

export interface LogNotFoundError {
  readonly code: 'log-not-found';
  readonly message: string;
  readonly logEntryId: LogEntryId;
}

/**
 * A Kind-B fact needs on-read refresh but its `source.refresh.handler`
 * doesn't resolve to a registered handler.
 */
export interface RefreshHandlerMissingError {
  readonly code: 'refresh-handler-missing';
  readonly message: string;
  readonly handlerId: string;
}

/**
 * A write attempted on a legal-hold fact (retention.legalHold = true) or
 * a delete attempted on a fact whose retention window is still open.
 */
export interface RetentionViolationError {
  readonly code: 'retention-violation';
  readonly message: string;
  readonly factId: FactId;
  readonly reason: 'legal-hold' | 'keep-until' | 'keep-days';
}

export interface PersistenceError {
  readonly code: 'persistence-error';
  readonly message: string;
  readonly cause: unknown;
}
