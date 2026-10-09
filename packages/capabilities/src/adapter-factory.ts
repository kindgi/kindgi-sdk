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
  /**
   * What's wrong with a provider registration for this adapter, read
   * statically: its `adapter_config`, its metadata, and whether it names a
   * secret. No network, no secret resolution (a registration's secret may
   * be set after it registers), no client built. An empty list means the
   * factory will take it.
   *
   * The runtime runs it when a provider registers (a problem refuses the
   * registration, naming the field) and when someone checks a registered
   * provider. It must agree with `factory`: build both from the same
   * functions, so a registration the check passes is one the factory
   * accepts, and each problem's message is the error the factory throws.
   * Absent: the adapter has no check, and registration takes any flat
   * `adapter_config`.
   */
  readonly checkConfig?: (input: AdapterConfigCheckInput) => readonly AdapterConfigProblem[];
}

/** What `AdapterFactoryEntry.checkConfig` reads: a registration, without its secret. */
export interface AdapterConfigCheckInput {
  readonly metadata: ProviderMetadata;
  readonly config?: AdapterConfig;
  /** Whether the registration names a secret (`secret_ref`). Its value is never read here. */
  readonly hasSecretRef: boolean;
  /**
   * Which of its own cloud identities the runtime has (`AdapterFactoryInput.identities`), so a
   * registration that signs in as one the runtime lacks is refused when it registers, not
   * when it's first used. A registry made with `identities` fills it. Absent: not known, and
   * the factory refuses instead.
   */
  readonly identities?: AdapterIdentitiesPresent;
}

/** Which of `AdapterIdentities` a runtime has: `true` for each it can sign in as. */
export type AdapterIdentitiesPresent = { readonly [K in keyof AdapterIdentities]-?: boolean };

/** `identities`, as the check input names them: which are there. */
export function identitiesPresent(
  identities: AdapterIdentities | undefined,
): AdapterIdentitiesPresent {
  return { azure: identities?.azure !== undefined, aws: identities?.aws !== undefined };
}

/**
 * One thing wrong with a registration (`AdapterFactoryEntry.checkConfig`),
 * in the shape of the API's validation issues (`{ path, message }`).
 */
export interface AdapterConfigProblem {
  /**
   * The setting at fault, as a JSON pointer into the registration:
   * `/adapter_config/<key>`, `/secret_ref`, `/metadata/region`,
   * `/metadata/models/<i>/name`.
   */
  readonly path: string;
  /**
   * What's wrong with that setting and what it takes, without the adapter
   * or provider (e.g. `adapter_config.api must be one of responses,
   * chat-completions.`): the API lists it under its own sentence. The
   * factory throws it as `adapterConfigError` words it.
   */
  readonly message: string;
}

/**
 * The error an adapter's factory throws for a problem its `checkConfig`
 * reports: `<adapterId>: provider "<providerId>": <message>`. Both read the
 * registration through the same functions, so they say the same thing.
 */
export function adapterConfigError(
  adapterId: string,
  providerId: string,
  problem: AdapterConfigProblem,
): Error {
  return new Error(`${adapterId}: provider "${providerId}": ${problem.message}`);
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
  /**
   * The runtime's own cloud identities, for a registration that signs in as
   * the server rather than with a key (Azure OpenAI `auth: entra`; Bedrock
   * `auth: aws-identity`). The runtime fills each from settings that name it
   * explicitly (`KINDGI_AZURE_CLIENT_ID`, `KINDGI_AWS_IDENTITY`), never from
   * whatever ambient credentials the environment holds. Absent: the runtime
   * has none; an adapter that needs one refuses, naming the setting.
   */
  readonly identities?: AdapterIdentities;
}

/** The runtime's cloud identities an adapter may sign in with (`AdapterFactoryInput.identities`). */
export interface AdapterIdentities {
  readonly azure?: AzureTokenClient;
  readonly aws?: AwsCredentialClient;
}

/**
 * An Entra (Azure AD) token source. An `@azure/identity` `TokenCredential`
 * satisfies it; adapters depend on this shape, not on that library.
 */
export interface AzureTokenClient {
  getToken(
    scopes: string | string[],
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<{ readonly token: string } | null>;
}

/** Short-lived AWS credentials, as an AWS SDK credential provider resolves them. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

/**
 * An AWS credential provider that refreshes: call it for every request (it
 * caches and renews itself), never keep what it returns.
 */
export type AwsCredentialClient = () => Promise<AwsCredentials>;

/** An adapter's connection settings: flat, non-secret values. */
export type AdapterConfig = Readonly<Record<string, string | number | boolean>>;

export type AdapterFactory = (input: AdapterFactoryInput) => ModelProvider;

export interface AdapterFactoryRegistry {
  register(entry: AdapterFactoryEntry): void;
  get(adapterId: string): AdapterFactoryEntry | undefined;
  has(adapterId: string): boolean;
  list(): readonly AdapterFactoryEntry[];
}

/** How a runtime makes its `AdapterFactoryRegistry`. */
export interface AdapterFactoryRegistryOptions {
  /**
   * The runtime's own cloud identities. Each entry's factory gets them as
   * `AdapterFactoryInput.identities` (unless its input names its own), and
   * its `checkConfig` learns which are there (`AdapterConfigCheckInput.identities`),
   * so the two agree: a registration needing one the runtime lacks is refused
   * when it registers.
   */
  readonly identities?: AdapterIdentities;
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
  options: AdapterFactoryRegistryOptions = {},
): AdapterFactoryRegistry {
  const entries = new Map<string, AdapterFactoryEntry>();
  const { identities } = options;

  function register(entry: AdapterFactoryEntry): void {
    if (entries.has(entry.adapterId)) {
      throw new Error(
        `AdapterFactoryRegistry: "${entry.adapterId}" is already registered. Duplicate adapter registration at boot indicates a wiring bug.`,
      );
    }
    entries.set(
      entry.adapterId,
      identities === undefined ? entry : withIdentities(entry, identities),
    );
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

/** An entry whose factory and check know the runtime's identities. */
function withIdentities(
  entry: AdapterFactoryEntry,
  identities: AdapterIdentities,
): AdapterFactoryEntry {
  const present = identitiesPresent(identities);
  const { checkConfig } = entry;
  return {
    ...entry,
    factory: (input) => entry.factory({ ...input, identities: input.identities ?? identities }),
    ...(checkConfig !== undefined && {
      checkConfig: (input) => checkConfig({ ...input, identities: input.identities ?? present }),
    }),
  };
}
