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
import { fileParts, samplingFor } from '@kindgi/capabilities';
import { createAttemptCounter } from '@kindgi/capabilities/attempts';
import { createClientsByKey } from '@kindgi/capabilities/clients-by-key';
import { nameToolsAsSent, toolIdsBySentName } from '@kindgi/capabilities/tool-names';
import { headerValueProblem } from '@kindgi/types';

import { withPromptCache } from './cache.js';
import { type CostRates, computeCostUsd, toFrameworkUsage } from './cost.js';
import {
  decodeToolName,
  encodeToolName,
  fromAnthropicResponse,
  mapStopReason,
  toAnthropicMessages,
  toAnthropicTools,
} from './translate.js';

/**
 * Anthropic-specific `ModelInfo` extension. Widens the framework's
 * `ModelInfo.cost` with the two Anthropic prompt-cache multipliers
 * (`promptCacheCreationMultiplier`, `promptCacheReadMultiplier`) that
 * `computeCostUsd` uses to bill cache activity per invocation, and a
 * `longContext` tier for a model that prices long prompts higher.
 *
 * When either multiplier is omitted the framework falls back to
 * Anthropic's 5-minute-tier defaults (1.25 / 0.1) inside `cost.ts`.
 */
export interface AnthropicModelInfo extends ModelInfo {
  readonly cost: ModelInfo['cost'] & Omit<CostRates, keyof ModelInfo['cost']>;
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
/** Anthropic's API: the SDK's own default, given explicitly so `ANTHROPIC_BASE_URL` can't move it. */
const ANTHROPIC_API_URL = 'https://api.anthropic.com';

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

  // One SDK client per resolved key, reused while that key is, so an invoke
  // doesn't build one. Connections live in the `fetch` every client sends
  // with, so they're kept either way. Calls whose keys take turns (a run in
  // each of two projects with keys of their own) each reuse their own; a
  // rotated key builds a new one. A dep-injected client is used as is,
  // whatever the resolver says: callers injecting one opt out of key
  // rotation.
  const clients = createClientsByKey<Anthropic>();
  // Counts each call's HTTP attempts, the SDK's own retries included (its
  // retry policy stays the SDK's), through the `fetch` the client sends with.
  const attempts = createAttemptCounter(options.clientOptions?.fetch);

  async function resolveApiKey(): Promise<string> {
    const key = typeof options.apiKey === 'function' ? await options.apiKey() : options.apiKey;
    // Checked before the SDK sends it: fetch's own error for a key it can't
    // send (a line break inside) quotes the key, into the call's failure.
    const problem = headerValueProblem(key);
    if (problem !== undefined) {
      throw new Error(
        `@kindgi/adapter-model-anthropic: provider "${metadata.id}": its API key has ${problem}, which a header can't carry: store the secret without it`,
      );
    }
    return key;
  }

  async function resolveClient(): Promise<Anthropic> {
    if (options.client !== undefined) return options.client;
    const key = await resolveApiKey();
    return clients.get(
      key,
      () =>
        new Anthropic({
          apiKey: key,
          // Never from the server's environment: left out, the SDK reads
          // ANTHROPIC_AUTH_TOKEN (sent as a bearer beside the provider's own key,
          // on every provider's calls) and ANTHROPIC_BASE_URL.
          authToken: null,
          baseURL: options.baseURL ?? ANTHROPIC_API_URL,
          ...(options.clientOptions ?? {}),
          fetch: attempts.fetch,
        }),
    );
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

      // Images and PDFs go to a model that declares `vision`; text files to any.
      const vision = modelInfo.features.includes('vision');
      const files = await fileParts(input.messages, {
        readFile: input.readFile,
        images: vision,
        documents: vision,
      });
      const translated = toAnthropicMessages(input.messages, files);
      // The system prompt names the call's tools as they're sent (`acme__lookup_order`):
      // a model told to call `acme.lookup_order` calls a name it wasn't given (T311).
      const toolNames = input.tools?.map((t) => t.name) ?? [];
      // A call names its tool by the name it was sent: back to the id by lookup.
      const toolIdOf = toolIdsBySentName(toolNames, encodeToolName, decodeToolName);
      // Cache breakpoints on the tools, the agent's prompt and, when the call
      // can continue, the conversation so far (`withPromptCache`).
      const { system, tools, messages } = withPromptCache({
        systemParts: translated.systemParts.map((part) =>
          nameToolsAsSent(part, toolNames, encodeToolName),
        ),
        tools:
          input.tools !== undefined && input.tools.length > 0
            ? toAnthropicTools(input.tools)
            : undefined,
        messages: translated.messages,
      });

      // `traceparent` is a header on this request only, when the caller
      // sets it (the provider's registration opted in); never logged.
      const requestOptions: Record<string, unknown> = {
        ...(input.abortSignal !== undefined && { signal: input.abortSignal }),
        ...(input.traceparent !== undefined && { headers: { traceparent: input.traceparent } }),
      };
      const maxTokens = input.maxOutputTokens ?? modelInfo.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
      const sampling = samplingFor(modelInfo, input);
      const thinking = input.thinking === 'lowest' ? lowestThinking(modelInfo) : {};

      const counted = await attempts.count(() =>
        client.messages.create(
          {
            model: input.model,
            max_tokens: maxTokens,
            ...(system !== undefined && { system }),
            messages,
            ...(tools !== undefined && { tools }),
            ...(sampling.temperature !== undefined && { temperature: sampling.temperature }),
            ...thinking,
          },
          requestOptions,
        ),
      );
      const response = counted.value;

      const durationMs = Date.now() - startedAt;
      const message = fromAnthropicResponse(response, toolIdOf);
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

/**
 * The request fields for a model's least thinking (`ModelCallInput.thinking:
 * 'lowest'`). A thinking type that turns it off (Haiku 5.5's `disabled`,
 * Sonnet 5.5's `between_tools`) is taken only at effort `high` or below,
 * so it goes with effort `low`; a model that always thinks (Opus 5.5) gets
 * the effort alone. The SDK's types predate both fields; the API takes them
 * as sent.
 */
function lowestThinking(model: ModelInfo): Record<string, unknown> {
  const lowest = model.thinking?.lowest;
  if (lowest === undefined) return {};
  if (lowest === 'disabled' || lowest === 'between_tools') {
    return { thinking: { type: lowest }, output_config: { effort: 'low' } };
  }
  return { output_config: { effort: lowest } };
}
