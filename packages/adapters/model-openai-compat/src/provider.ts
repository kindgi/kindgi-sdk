// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import OpenAI from 'openai';

import type {
  AdapterFactory,
  AdapterFactoryInput,
  Feature,
  ModelCallInput,
  ModelCallResult,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  ModelToolCall,
  ModelToolDefinition,
  ProviderMetadata,
  UsageCounters,
} from '@kindgi/capabilities';
import { createAttemptCounter } from '@kindgi/capabilities/attempts';
import { nameToolsAsSent } from '@kindgi/capabilities/tool-names';

/**
 * OpenAI (and every downstream compat endpoint — Ollama, vLLM, Groq,
 * OpenRouter, Together, Fireworks, LiteLLM, ...) constrains
 * `function.name` to `^[a-zA-Z0-9_-]{1,128}$` — dots are rejected.
 * The framework's tool id convention is `<pack>.<tool>`, so this
 * adapter transparently encodes on send and decodes on receive.
 *
 * See the sibling comment in
 * `packages/adapters/model-anthropic/src/translate.ts` — same
 * substitution (`.` → `__`), same reversibility caveat (authors
 * should not put literal `__` in tool ids).
 */
function encodeToolName(name: string): string {
  return name.replace(/\./g, '__');
}

function decodeToolName(name: string): string {
  return name.replace(/__/g, '.');
}

/**
 * Configuration for an OpenAI-compatible ModelProvider. `baseURL` is the
 * key — same adapter, different endpoints (the well-known ones are
 * exported as `BASE_URLS`):
 *
 *   - OpenAI proper:  `https://api.openai.com/v1`
 *   - Ollama:         `http://localhost:11434/v1`
 *   - vLLM:           `http://localhost:8000/v1`
 *   - llama-server:   `http://localhost:8080/v1`
 *   - LM Studio:      `http://localhost:1234/v1`
 *   - OpenRouter:     `https://openrouter.ai/api/v1`
 *   - Groq:           `https://api.groq.com/openai/v1`
 *   - Together:       `https://api.together.xyz/v1`
 *   - Fireworks:      `https://api.fireworks.ai/inference/v1`
 *   - DeepInfra:      `https://api.deepinfra.com/v1/openai`
 *   - LiteLLM proxy:  `http://localhost:4000/v1`
 *
 * `apiKey` is required by most hosted endpoints; some local runners
 * (Ollama, vLLM, llama-server) accept a placeholder or none — the SDK
 * still needs a non-empty string so pass anything like `'unused'`. It
 * may be a resolver, called on every invoke, so a rotated key takes
 * effect on the next call (the client is rebuilt when the key changes).
 *
 * `metadata.models[]` MUST list every model the caller expects to
 * invoke through this connection; the adapter picks the right entry
 * at invoke time based on `ModelCallInput.model`. Cost per 1K tokens
 * is caller-supplied per model — the OpenAI wire format doesn't
 * expose pricing, and each provider bills differently.
 */
export interface OpenAICompatProviderOptions {
  readonly baseURL: string;
  readonly apiKey: string | (() => string | Promise<string>);
  /** Metadata surfaced to the router — required. */
  readonly metadata: ProviderMetadata;
  /** Optional HTTP overrides passed through to the OpenAI SDK. */
  readonly clientOptions?: Omit<
    NonNullable<ConstructorParameters<typeof OpenAI>[0]>,
    'apiKey' | 'baseURL'
  >;
  /**
   * Fields merged into every Chat Completions request body: settings an
   * endpoint takes that the OpenAI format has no field for. A Qwen
   * thinking model served by vLLM, SGLang or llama-server answers with its
   * thinking first unless asked not to:
   * `{ chat_template_kwargs: { enable_thinking: false } }`. The fields the
   * adapter sets itself (`EXTRA_BODY_RESERVED`) are refused.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/** Request fields the adapter sets itself; `extraBody` can't override them. */
export const EXTRA_BODY_RESERVED = [
  'model',
  'messages',
  'tools',
  'response_format',
  'temperature',
  'max_tokens',
  'stream',
] as const;

/**
 * Create an OpenAI-compatible `ModelProvider`. The OpenAI SDK is
 * instantiated lazily at first invoke — construction cost is minimal
 * but we want to keep import-side effects zero for shape tests.
 */
export function createOpenAICompatModelProvider(
  options: OpenAICompatProviderOptions,
): ModelProvider {
  const metadata = options.metadata;
  const problem = extraBodyProblem(options.extraBody);
  if (problem !== undefined) {
    throw new Error(`${OPENAI_COMPAT_ADAPTER_ID}: provider "${metadata.id}": ${problem}`);
  }
  const extraBody = options.extraBody ?? {};
  const modelsByName = new Map<string, ModelInfo>(metadata.models.map((m) => [m.name, m] as const));
  // One client per key: reused while the resolver returns the same key
  // (the SDK keeps its connection pool), rebuilt when it rotates.
  let cached: { readonly key: string; readonly client: OpenAI } | undefined;
  // Counts each call's HTTP attempts, the SDK's own retries included (its
  // retry policy stays the SDK's), through the `fetch` the client sends with.
  const attempts = createAttemptCounter(options.clientOptions?.fetch);
  async function clientForCall(): Promise<OpenAI> {
    const key = typeof options.apiKey === 'function' ? await options.apiKey() : options.apiKey;
    if (cached !== undefined && cached.key === key) return cached.client;
    const client = new OpenAI({
      apiKey: key,
      baseURL: options.baseURL,
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
          `@kindgi/adapter-model-openai-compat: provider "${metadata.id}" does not expose model "${input.model}". ` +
            `Available: ${[...modelsByName.keys()].join(', ') || '<none>'}.`,
        );
      }
      const startedAt = Date.now();
      const openai = await clientForCall();

      // The system prompt names the call's tools as they're sent (`acme__lookup_order`):
      // a model told to call `acme.lookup_order` calls a name it wasn't given (T311).
      const toolIds = input.tools?.map((t) => t.name) ?? [];
      const messages = input.messages.map((m) =>
        toOpenAiMessage(
          m.role === 'system'
            ? { ...m, content: nameToolsAsSent(m.content, toolIds, encodeToolName) }
            : m,
        ),
      );
      const tools = input.tools?.map(toOpenAiTool);

      const responseFormat = input.structuredOutput
        ? {
            type: 'json_schema' as const,
            json_schema: {
              name: input.structuredOutput.name,
              schema: input.structuredOutput.schema,
              strict: true,
            },
          }
        : undefined;

      const counted = await attempts.count(() =>
        openai.chat.completions.create(
          {
            ...extraBody,
            model: input.model,
            messages,
            ...(tools !== undefined && tools.length > 0 && { tools }),
            ...(responseFormat !== undefined && { response_format: responseFormat }),
            ...(input.temperature !== undefined && { temperature: input.temperature }),
            ...(input.maxOutputTokens !== undefined && { max_tokens: input.maxOutputTokens }),
            stream: false,
          },
          input.abortSignal !== undefined ? { signal: input.abortSignal } : undefined,
        ),
      );
      const completion = counted.value;

      const durationMs = Date.now() - startedAt;
      const choice = completion.choices[0];
      const contentText = choice?.message.content ?? '';
      const toolCalls = extractToolCalls(choice?.message.tool_calls);
      const responseMessage: ModelMessage = {
        role: 'assistant',
        content: contentText,
        ...(toolCalls.length > 0 && { toolCalls }),
      };

      const usage = toFrameworkUsage(completion.usage);

      return {
        message: responseMessage,
        finishReason: mapFinishReason(choice?.finish_reason),
        usage,
        costUsd: computeCost(modelInfo, usage.promptTokens, usage.completionTokens),
        durationMs,
        provider: { id: metadata.id, model: input.model },
        ...(completion.model !== undefined &&
          completion.model !== '' && {
            servedModel: completion.model,
          }),
        ...(typeof completion._request_id === 'string' && {
          providerRequestId: completion._request_id,
        }),
        // An injected client sends with its own fetch: nothing was counted.
        ...(counted.attempts > 0 && { attempts: counted.attempts }),
        ...(completion.usage !== undefined && { rawUsage: { ...completion.usage } }),
      };
    },
  };
}

function toOpenAiMessage(m: ModelMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.toolCallId ?? '',
    };
  }
  if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          // Encode when replaying prior assistant turns — see the
          // module-level comment on `encodeToolName`.
          name: encodeToolName(tc.name),
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }
  if (m.role === 'system') return { role: 'system', content: m.content };
  if (m.role === 'user') return { role: 'user', content: m.content };
  return { role: 'assistant', content: m.content };
}

function toOpenAiTool(tool: ModelToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: encodeToolName(tool.name),
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

function extractToolCalls(
  raw: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): ModelToolCall[] {
  if (raw === undefined || raw.length === 0) return [];
  const out: ModelToolCall[] = [];
  for (const tc of raw) {
    if (tc.type !== 'function') continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      args = {};
    }
    // Decode: the wire returns the encoded name; the framework
    // expects the canonical dotted form.
    out.push({ id: tc.id, name: decodeToolName(tc.function.name), arguments: args });
  }
  return out;
}

function mapFinishReason(reason: string | null | undefined): ModelCallResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool-use';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'stop';
  }
}

function computeCost(modelInfo: ModelInfo, promptTokens: number, completionTokens: number): number {
  const promptCost = (promptTokens / 1000) * modelInfo.cost.promptUsdPer1kTokens;
  const completionCost = (completionTokens / 1000) * modelInfo.cost.completionUsdPer1kTokens;
  return promptCost + completionCost;
}

/**
 * Well-known base URLs — surfaced as constants so callers can import
 * without typos. Adding a new alias here doesn't lock anyone in; the
 * adapter accepts any `baseURL` string.
 */
export const BASE_URLS = {
  OPENAI: 'https://api.openai.com/v1',
  OLLAMA_LOCAL: 'http://localhost:11434/v1',
  VLLM_LOCAL: 'http://localhost:8000/v1',
  LLAMA_SERVER_LOCAL: 'http://localhost:8080/v1',
  LM_STUDIO_LOCAL: 'http://localhost:1234/v1',
  OPENROUTER: 'https://openrouter.ai/api/v1',
  GROQ: 'https://api.groq.com/openai/v1',
  TOGETHER: 'https://api.together.xyz/v1',
  FIREWORKS: 'https://api.fireworks.ai/inference/v1',
  DEEPINFRA: 'https://api.deepinfra.com/v1/openai',
  LITELLM_LOCAL: 'http://localhost:4000/v1',
} as const;

export type Feature_ = Feature; // local alias; not exported from the package entry (src/index.ts)

/** The id the runtime registers this adapter under. */
export const OPENAI_COMPAT_ADAPTER_ID = '@kindgi/adapter-model-openai-compat';

/** The key sent when a registration has none: local runners ignore it. */
const NO_KEY = 'unused';

/**
 * The runtime's factory. A provider registration names its endpoint in
 * `adapter_config.baseURL` (an http(s) URL; `BASE_URLS` has the
 * well-known ones) and, for an endpoint that needs a key, its secret in
 * `secret_ref` (resolved on every call). Without one, the adapter sends
 * a placeholder key, as local runners (Ollama, vLLM, llama-server)
 * expect. Its `extraBody.*` keys (`EXTRA_BODY_PREFIX`) are extra request
 * fields, merged into every request (`OpenAICompatProviderOptions.extraBody`).
 */
export const openAICompatAdapterFactory: AdapterFactory = (input) => {
  const extraBody = openAICompatExtraBody(input);
  return createOpenAICompatModelProvider({
    metadata: input.metadata,
    baseURL: openAICompatBaseUrl(input),
    apiKey: input.resolveApiKey ?? NO_KEY,
    ...(extraBody !== undefined && { extraBody }),
    // The registration chose the endpoint: the runtime's fetch decides
    // which hosts it may reach (`AdapterFactoryInput.fetch`).
    ...(input.fetch !== undefined && { clientOptions: { fetch: input.fetch } }),
  });
};

/** The endpoint a registration names (see `openAICompatAdapterFactory`). */
export function openAICompatBaseUrl(input: AdapterFactoryInput): string {
  const value = input.config?.baseURL;
  if (typeof value !== 'string' || !/^https?:\/\/[^\s/]+/.test(value)) {
    throw new Error(
      `${OPENAI_COMPAT_ADAPTER_ID}: provider "${input.metadata.id}" needs adapter_config.baseURL, an http(s) URL (e.g. ${BASE_URLS.OPENAI}).`,
    );
  }
  return value;
}

/**
 * The `adapter_config` key prefix for extra request fields. `adapter_config`
 * is flat, so each field is its own key and dots nest:
 * `"extraBody.chat_template_kwargs.enable_thinking": false` sends
 * `{ "chat_template_kwargs": { "enable_thinking": false } }`.
 */
export const EXTRA_BODY_PREFIX = 'extraBody.';

/** Names that would reach an object's prototype; never a field name here. */
const UNSAFE_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A registration's extra request fields: its `adapter_config` keys under
 * `EXTRA_BODY_PREFIX`, expanded into the body they add. `undefined` when it
 * has none. Throws, naming the key, on an empty or unsafe field name, two
 * keys that collide, or a field the adapter sets.
 */
export function openAICompatExtraBody(
  input: AdapterFactoryInput,
): Readonly<Record<string, unknown>> | undefined {
  const fail = (problem: string): never => {
    throw new Error(`${OPENAI_COMPAT_ADAPTER_ID}: provider "${input.metadata.id}": ${problem}`);
  };
  const config = input.config ?? {};
  if (Object.hasOwn(config, 'extraBody')) {
    fail(
      `adapter_config takes extra request fields one per key, "${EXTRA_BODY_PREFIX}<field>" (dots nest), e.g. "${EXTRA_BODY_PREFIX}chat_template_kwargs.enable_thinking": false`,
    );
  }
  let body: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith(EXTRA_BODY_PREFIX)) continue;
    body ??= {};
    const problem = setField(body, key.slice(EXTRA_BODY_PREFIX.length).split('.'), value);
    if (problem !== undefined) fail(`adapter_config "${key}" ${problem}`);
  }
  const problem = extraBodyProblem(body);
  if (problem !== undefined) fail(`adapter_config ${problem}`);
  return body;
}

/** Set `path` in `body` to `value`; what's wrong, if anything. */
function setField(body: Record<string, unknown>, path: readonly string[], value: unknown) {
  if (path.some((field) => field === '' || UNSAFE_FIELDS.has(field))) {
    return "isn't a field path";
  }
  let node = body;
  for (const field of path.slice(0, -1)) {
    const next = Object.hasOwn(node, field) ? node[field] : undefined;
    if (next === undefined) {
      const child: Record<string, unknown> = {};
      node[field] = child;
      node = child;
    } else if (typeof next === 'object' && next !== null) {
      node = next as Record<string, unknown>;
    } else {
      return 'nests under a field another key sets';
    }
  }
  const leaf = path[path.length - 1] as string;
  if (Object.hasOwn(node, leaf)) return 'collides with another key';
  node[leaf] = value;
  return undefined;
}

function extraBodyProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'extraBody must be an object of request fields, e.g. { chat_template_kwargs: { enable_thinking: false } }';
  }
  const reserved = EXTRA_BODY_RESERVED.filter((key) => Object.hasOwn(value, key));
  return reserved.length > 0
    ? `extraBody can't set ${reserved.join(', ')}: the adapter sets ${reserved.length === 1 ? 'it' : 'them'}`
    : undefined;
}

/**
 * The completion's usage as the framework's counters. The endpoint's
 * `prompt_tokens` include cached ones (`prompt_tokens_details.cached_tokens`),
 * and its `completion_tokens` include reasoning
 * (`completion_tokens_details.reasoning_tokens`): reported apart when the
 * endpoint gives them. OpenAI doesn't report cache writes.
 */
function toFrameworkUsage(usage: OpenAI.CompletionUsage | undefined): UsageCounters {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    // A part the endpoint reports is kept, 0 included.
    ...(typeof cacheRead === 'number' && { cacheReadTokens: cacheRead }),
    ...(typeof reasoning === 'number' && { reasoningTokens: reasoning }),
  };
}
