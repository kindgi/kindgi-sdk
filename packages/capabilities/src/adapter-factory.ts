// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelProvider, ProviderMetadata } from './types.js';

/**
 * In-process factory-function registry — the code-side counterpart of a
 * persistent adapter registry (`AdapterRegistryBinding` in
 * `@kindgi/api`). A store can hold adapter records but not JavaScript
 * functions, so the runtime keeps a Map keyed by the same adapter id
 * the stored record uses.
 *
 * Populated at boot by deployment code, in lockstep with the adapters
 * it registers in storage. A storage-backed provider registry reads a
 * tenant's stored providers, looks up each one's adapter id here, calls
 * the factory to instantiate a `ModelProvider`, and caches the result.
 *
 * Failure surfaces:
 *   - A stored provider references an adapter id with no in-process
 *     factory (deployment forgot to register it, or a boot ordering
 *     bug) → `get(adapterId)` returns `undefined`, and the provider
 *     registry fails the invocation with a clear error.
 *   - Factory throws at construction time → propagates through the
 *     provider registry to the caller.
 */
export interface AdapterFactoryEntry {
  /** Adapter identifier — MUST equal the id of the stored adapter record. */
  readonly adapterId: string;
  /** Capability kind this adapter fulfils (`'llm-inference'`, `'embedding'`, ...). */
  readonly capabilityKind: string;
  readonly factory: AdapterFactory;
  /**
   * Optional download / warmup step. Adapters that need
   * expensive one-time setup (in-process model downloads, ONNX
   * runtime warmup, cache preheating) implement this; adapters that
   * only need config-time construction leave it undefined.
   *
   * Streams `PrepareEvent`s so the caller (HTTP SSE endpoint,
   * console progress bar) can render progress. Framework doesn't
   * cache — implementations decide whether re-invoking `prepare` on
   * an already-prepared adapter is a no-op or a re-check.
   *
   * `params` shape is adapter-specific — the framework passes it
   * through unchanged (e.g. `{model: 'smollm2-360m'}` for
   * in-process).
   */
  readonly prepare?: (params?: Readonly<Record<string, unknown>>) => AsyncIterable<PrepareEvent>;
}

/**
 * Event stream emitted by `AdapterFactoryEntry.prepare()`. Shape kept
 * deliberately open (`message` + optional numeric progress fields)
 * so adapters with different progress models (byte-count download,
 * step-count warmup, cache hit ratio) can populate what they know.
 * Consumers render whichever fields are present.
 */
export type PrepareEvent =
  | {
      readonly kind: 'progress';
      readonly message?: string;
      /** Ratio in [0, 1] when known; absent for indeterminate progress. */
      readonly ratio?: number;
      readonly loadedBytes?: number;
      readonly totalBytes?: number;
      readonly file?: string;
    }
  | { readonly kind: 'ready'; readonly message?: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Input passed to an adapter factory at instantiation time. The
 * provider registry composes the arguments from persisted state (the
 * stored provider `metadata`) plus a pre-bound `resolveApiKey` closure
 * that reads the tenant-scoped secret store.
 *
 * Adapters that don't need credentials (dev-echo, in-process
 * models) receive no `resolveApiKey` — they ignore the field
 * entirely.
 */
export interface AdapterFactoryInput {
  readonly metadata: ProviderMetadata;
  /**
   * How the adapter connects — the provider's adapter-specific,
   * non-secret settings (a cloud project, a base URL), as registered
   * with the provider. Credentials never go here; they come from
   * `resolveApiKey`. Each adapter documents and validates its own keys.
   */
  readonly config?: AdapterConfig;
  /**
   * Lazy API-key resolver. Adapters that need external
   * credentials pass this into their SDK client construction (or
   * refresh on every invoke, as
   * `@kindgi/adapter-model-anthropic` does).
   */
  readonly resolveApiKey?: () => Promise<string>;
  /**
   * The fetch for a provider endpoint the registration chose (a base URL).
   * The runtime passes one that refuses the hosts its deployment forbids
   * (`KINDGI_TENANT_HOST_ACCESS`: the cloud metadata endpoints and the
   * server's own host). Absent: the global `fetch`.
   */
  readonly fetch?: typeof fetch;
}

/** An adapter's connection settings: flat, non-secret values. */
export type AdapterConfig = Readonly<Record<string, string | number | boolean>>;

export type AdapterFactory = (input: AdapterFactoryInput) => ModelProvider;

export interface AdapterFactoryRegistry {
  register(entry: AdapterFactoryEntry): void;
  get(adapterId: string): AdapterFactoryEntry | undefined;
  has(adapterId: string): boolean;
  list(): readonly AdapterFactoryEntry[];
}

/**
 * Create an in-memory `AdapterFactoryRegistry`. Global
 * (deployment-scoped) — every tenant reads from the same map because
 * adapter code is code, not user data.
 *
 * Duplicate registrations under the same `adapterId` throw at
 * `register` time; accidental clobber of a running factory would be
 * catastrophic. Deployments call `register` once per shipped adapter
 * at boot.
 */
export function createAdapterFactoryRegistry(
  seed: readonly AdapterFactoryEntry[] = [],
): AdapterFactoryRegistry {
  const entries = new Map<string, AdapterFactoryEntry>();

  function register(entry: AdapterFactoryEntry): void {
    if (entries.has(entry.adapterId)) {
      throw new Error(
        `AdapterFactoryRegistry: "${entry.adapterId}" is already registered. Duplicate adapter registration at boot indicates a wiring bug.`,
      );
    }
    entries.set(entry.adapterId, entry);
  }

  for (const entry of seed) register(entry);

  return {
    register,
    get(adapterId): AdapterFactoryEntry | undefined {
      return entries.get(adapterId);
    },
    has(adapterId): boolean {
      return entries.has(adapterId);
    },
    list(): readonly AdapterFactoryEntry[] {
      return [...entries.values()];
    },
  };
}
