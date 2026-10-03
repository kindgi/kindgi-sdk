// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

import type {
  AmbiguousDefaultProviderError,
  DuplicateEmbeddingProviderError,
  NoEmbeddingProviderError,
  UnknownEmbeddingModelError,
} from './errors.js';
import type { EmbeddingProvider } from './types.js';

/**
 * Process-wide registry of embedding providers, keyed by
 * `provider.describe().model`.
 *
 * Registered once at boot (typically alongside model providers +
 * storage). Consumer code (memory writeFact / searchBySemantic, agent
 * retrieval) reads from the registry instead of receiving a provider
 * per call.
 *
 * Not tenant-scoped — providers are process-global. Which model a
 * tenant is allowed to use is a separate concern, outside the registry.
 */
export interface EmbeddingProviderRegistry {
  /**
   * Register a provider. Rejects if `describe().model` already exists —
   * accidental re-registration would swap the implementation for a
   * model that already has vectors in the store, silently corrupting
   * the index.
   */
  register(provider: EmbeddingProvider): Result<void, DuplicateEmbeddingProviderError>;

  /** Lookup by `describe().model`. Undefined if not registered. */
  getByModel(model: string): EmbeddingProvider | undefined;

  /** All registered providers. Order is registration order. */
  list(): readonly EmbeddingProvider[];

  /** True iff a provider with this model is registered. */
  has(model: string): boolean;

  /** Registered provider count. */
  size(): number;

  /**
   * Resolve a provider for a caller. If `model` is provided, looks it
   * up. If omitted, returns the sole registered provider (zero → err,
   * >1 → err — the caller must be explicit).
   */
  resolve(
    model?: string,
  ): Result<
    EmbeddingProvider,
    NoEmbeddingProviderError | UnknownEmbeddingModelError | AmbiguousDefaultProviderError
  >;
}

/**
 * Build an in-memory registry seeded with the given providers.
 * Registration order is preserved. Duplicate models throw synchronously
 * from the seed (deliberate — a duplicate at construction is a config
 * bug the app should refuse to boot with).
 */
export function createEmbeddingProviderRegistry(
  seed: readonly EmbeddingProvider[] = [],
): EmbeddingProviderRegistry {
  const providers = new Map<string, EmbeddingProvider>();

  const registry: EmbeddingProviderRegistry = {
    register(provider: EmbeddingProvider): Result<void, DuplicateEmbeddingProviderError> {
      const model = provider.describe().model;
      if (providers.has(model)) {
        const err: DuplicateEmbeddingProviderError = {
          code: 'duplicate-embedding-provider',
          message: `Embedding provider for model "${model}" is already registered`,
          model,
        };
        return { kind: 'err', error: err };
      }
      providers.set(model, provider);
      return { kind: 'ok', value: undefined };
    },

    getByModel(model: string): EmbeddingProvider | undefined {
      return providers.get(model);
    },

    list(): readonly EmbeddingProvider[] {
      return [...providers.values()];
    },

    has(model: string): boolean {
      return providers.has(model);
    },

    size(): number {
      return providers.size;
    },

    resolve(model?: string) {
      if (model !== undefined) {
        const hit = providers.get(model);
        if (hit !== undefined) return { kind: 'ok', value: hit };
        const err: UnknownEmbeddingModelError = {
          code: 'unknown-embedding-model',
          message: `No embedding provider registered for model "${model}"`,
          model,
          known: [...providers.keys()],
        };
        return { kind: 'err', error: err };
      }
      if (providers.size === 0) {
        const err: NoEmbeddingProviderError = {
          code: 'no-embedding-provider',
          message: 'No embedding providers registered. Register one at boot.',
        };
        return { kind: 'err', error: err };
      }
      if (providers.size > 1) {
        const err: AmbiguousDefaultProviderError = {
          code: 'ambiguous-default-provider',
          message: `${providers.size} embedding providers registered; caller must pass an explicit model`,
          known: [...providers.keys()],
        };
        return { kind: 'err', error: err };
      }
      const only = providers.values().next().value;
      return { kind: 'ok', value: only as EmbeddingProvider };
    },
  };

  for (const p of seed) {
    const r = registry.register(p);
    if (r.kind === 'err') throw new Error(`seed provider rejected: ${r.error.message}`);
  }
  return registry;
}
