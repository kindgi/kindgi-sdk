// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Errors surfaced by the embedding sub-framework. Discriminated by
 * `code` — callers `switch (e.code)` to route.
 */
export type EmbeddingError =
  | NoEmbeddingProviderError
  | UnknownEmbeddingModelError
  | DuplicateEmbeddingProviderError
  | AmbiguousDefaultProviderError;

/**
 * A caller asked for semantic embedding work without naming a model,
 * and the registry is empty. (Naming an unregistered model yields
 * `unknown-embedding-model` instead.) Semantic embedding is opt-in —
 * no provider ships out of the box.
 */
export interface NoEmbeddingProviderError {
  readonly code: 'no-embedding-provider';
  readonly message: string;
}

/**
 * A caller asked for a specific `model` but no provider under that
 * name is registered. Includes the set of known models to aid
 * diagnosis.
 */
export interface UnknownEmbeddingModelError {
  readonly code: 'unknown-embedding-model';
  readonly message: string;
  readonly model: string;
  readonly known: readonly string[];
}

/**
 * A provider is being registered whose `describe().model` already
 * belongs to another provider in the registry. Deliberate — accidental
 * re-registration would silently swap the active implementation for a
 * model already producing vectors in the store, corrupting the index.
 */
export interface DuplicateEmbeddingProviderError {
  readonly code: 'duplicate-embedding-provider';
  readonly message: string;
  readonly model: string;
}

/**
 * Resolution rule for `resolve()` called without a model: exactly one
 * provider must be registered. Zero → `no-embedding-provider`; more
 * than one → this error — callers must pass an explicit model.
 */
export interface AmbiguousDefaultProviderError {
  readonly code: 'ambiguous-default-provider';
  readonly message: string;
  readonly known: readonly string[];
}
