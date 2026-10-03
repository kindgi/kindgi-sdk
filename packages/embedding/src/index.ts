// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type { EmbeddingProvider } from './types.js';
export { createEmbeddingProviderRegistry } from './registry.js';
export type { EmbeddingProviderRegistry } from './registry.js';
export type {
  AmbiguousDefaultProviderError,
  DuplicateEmbeddingProviderError,
  EmbeddingError,
  NoEmbeddingProviderError,
  UnknownEmbeddingModelError,
} from './errors.js';
