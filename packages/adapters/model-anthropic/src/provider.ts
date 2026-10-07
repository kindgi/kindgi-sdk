// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import Anthropic from '@anthropic-ai/sdk';

import type {
  ModelCallInput,
  ModelCallResult,
  ModelInfo,
  ModelProvider,
  ProviderMetadata,
} from '@kindgi/capabilities';
import { samplingFor } from '@kindgi/capabilities';
import { createAttemptCounter } from '@kindgi/capabilities/attempts';

import { computeCostUsd, toFrameworkUsage } from './cost.js';
import {
  fromAnthropicResponse,
  mapStopReason,
  toAnthropicMessages,
  toAnthropicTools,
} from './translate.js';

/**
 * Anthropic-specific `ModelInfo` extension. Widens the framework's
 * `ModelInfo.cost` with the two Anthropic prompt-cache multipliers
 * (`promptCacheCreationMultiplier`, `promptCacheReadMultiplier`) that
 * `computeCostUsd` uses to bill cache activity per invocation.
 *
 * When either multiplier is omitted the framework falls back to
 * Anthropic's 5-minute-tier defaults (1.25 / 0.1) inside `cost.ts`.
 */
export interface AnthropicModelInfo extends ModelInfo {
  readonly cost: ModelInfo['cost'] & {
    readonly promptCacheCreationMultiplier?: number;
    readonly promptCacheReadMultiplier?: number;
  };
}

/**
 * Configuration for the Anthropic `ModelProvider`.
 *
 * `apiKey` accepts either a static string or a lazy resolver
 * `() => Promise<string>`. The resolver form is what makes per-tenant
 * BYO keys work: each tenant's `ModelProvider` instance is registered
 * with a resolver that closes over that tenant's `SecretStore` scope
 * plus the secret name. The adapter calls the resolver on every
 * invocation, so rotating the underlying secret is transparent — the
 * next call gets the new key.
 *
 * `metadata` follows the same pattern as the OpenAI-compat model
 * adapter: caller-supplied, since Anthropic's API surface doesn't
 * advertise pricing / context-window / features and pricing changes
 * shouldn't force an adapter release. `models[]` is authoritative for
 * routing; the adapter picks the right model at invoke time based on
 * `ModelCallInput.model` (which must match one of `models[i].name`).
 */
export interface AnthropicProviderOptions {
  readonly apiKey: string | (() => string | Promise<string>);
  /**
   * Metadata surfaced to the router. `models[]` MUST list every model
   * the caller expects to invoke through this connection; the adapter
   * uses `input.model` to pick the right entry per call. Per-model
   * `cost` accepts Anthropic prompt-cache multipliers via
   * `AnthropicModelInfo`.
   */
  readonly metadata: Omit<ProviderMetadata, 'models'> & {
    readonly models: readonly AnthropicModelInfo[];
  };
  /** Override the base URL (proxy, gateway, region routing). */
  readonly baseURL?: string;
  /**
   * Additional SDK client options (timeouts, custom fetch, headers,
   * etc.). `apiKey` and `baseURL` from the top level always win.
   */
  readonly clientOptions?: Omit<
    NonNullable<ConstructorParameters<typeof Anthropic>[0]>,
    'apiKey' | 'baseURL'
  >;
  /**
   * Dependency-injected SDK client. When present, `apiKey` /
   * `baseURL` / `clientOptions` are ignored on construction (tests
   * pass a mock; production wires a shared client if needed).
   */
  readonly client?: Anthropic;
}

/**
 * Adapter-level fallback when neither `ModelCallInput.maxOutputTokens`
 * nor the picked `ModelInfo.maxOutputTokens` is set. Anthropic requires
 * `max_tokens` on every request.
 */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Create an Anthropic `ModelProvider`. Non-streaming: the framework's
 * `ModelProvider.invoke` returns a `Promise<ModelCallResult>` and
 * doesn't expose a streaming seam yet — a streaming adapter is a
 * separate primitive.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const metadata = options.metadata satisfies Omit<ProviderMetadata, 'models'> & {
    readonly models: readonly AnthropicModelInfo[];
  };
  // Build a name → model lookup so invoke can resolve in O(1). Callers
  // routinely hit the same model for a whole conversation; the map is
  // built once at construction.
  const modelsByName = new Map<string, AnthropicModelInfo>(
    metadata.models.map((m) => [m.name, m] as const),
  );

  // Cache the SDK client keyed by the currently-resolved API key. When
  // the resolver returns the same value it did last time, reuse the
  // client instance (SDK internally maintains a fetch agent and TCP
  // keepalive — throwing it away on every invoke would tank latency).
  // When the resolver returns a new value (key rotation), rebuild.
  let cached: { readonly key: string; readonly client: Anthropic } | undefined;
  // Counts each call's HTTP attempts, the SDK's own retries included (its
  // retry policy stays the SDK's), through the `fetch` the client sends with.
  const attempts = createAttemptCounter(options.clientOptions?.fetch);
  if (options.client !== undefined) {
    // Dep-injected client — pin to sentinel key so resolveClient below
    // always returns the same instance regardless of what the resolver
    // says. Callers using dep injection are opting out of key rotation.
    cached = { key: '<injected>', client: options.client };
  }

  async function resolveApiKey(): Promise<string> {
    if (typeof options.apiKey === 'function') return options.apiKey();
    return options.apiKey;
  }

  async function resolveClient(): Promise<Anthropic> {
    if (options.client !== undefined) return options.client;
    const key = await resolveApiKey();
    if (cached !== undefined && cached.key === key) return cached.client;
    const client = new Anthropic({
      apiKey: key,
      ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
      ...(options.clientOptions ?? {}),
      fetch: attempts.fetch,
    });
    cached = { key, client };
    return client;
  }

  return {
    metadata,
    async invoke(input: ModelCallInput): Promise<ModelCallResult> {
      const modelInfo = modelsByName.get(input.model);
      if (modelInfo === undefined) {
        throw new Error(
          `@kindgi/adapter-model-anthropic: provider "${metadata.id}" does not expose model "${input.model}". ` +
            `Available: ${[...modelsByName.keys()].join(', ') || '<none>'}.`,
        );
      }
      const startedAt = Date.now();
      const client = await resolveClient();

      const { system, messages } = toAnthropicMessages(input.messages);
      const tools =
        input.tools !== undefined && input.tools.length > 0
          ? toAnthropicTools(input.tools)
          : undefined;

      const requestOptions: Record<string, unknown> =
        input.abortSignal !== undefined ? { signal: input.abortSignal } : {};
      const maxTokens = input.maxOutputTokens ?? modelInfo.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
      const sampling = samplingFor(modelInfo, input);

      const counted = await attempts.count(() =>
        client.messages.create(
          {
            model: input.model,
            max_tokens: maxTokens,
            ...(system !== undefined && { system }),
            messages: [...messages],
            ...(tools !== undefined && { tools: [...tools] }),
            ...(sampling.temperature !== undefined && { temperature: sampling.temperature }),
          },
          requestOptions,
        ),
      );
      const response = counted.value;

      const durationMs = Date.now() - startedAt;
      const message = fromAnthropicResponse(response);
      const usage = toFrameworkUsage(response.usage);
      const costUsd = computeCostUsd(response.usage, modelInfo.cost);

      return {
        message,
        finishReason: mapStopReason(response.stop_reason),
        usage,
        costUsd,
        durationMs,
        provider: { id: metadata.id, model: input.model },
        ...(response.model !== undefined && { servedModel: response.model }),
        ...(typeof response._request_id === 'string' && {
          providerRequestId: response._request_id,
        }),
        // An injected client sends with its own fetch: nothing was counted.
        ...(counted.attempts > 0 && { attempts: counted.attempts }),
        rawUsage: { ...response.usage },
        ...(sampling.warnings.length > 0 && { warnings: sampling.warnings }),
      };
    },
  };
}
