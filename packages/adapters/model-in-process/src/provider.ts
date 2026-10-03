// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  Feature,
  ModelCallInput,
  ModelCallResult,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  ProviderMetadata,
} from '@kindgi/capabilities';

import { DEFAULT_LOCAL_MODEL, type LocalModel, MODEL_SPECS, type ModelSpec } from './models.js';

/**
 * Structural type for the transformers.js text-generation pipeline —
 * matches only the surface we actually depend on. The real module is
 * imported dynamically on first invoke so shape tests never touch the
 * ONNX runtime (which has ESM/CJS interop quirks with `onnxruntime-common`
 * under some Node versions).
 */
type TextGenerationPipeline = {
  tokenizer: {
    apply_chat_template?: (input: unknown, options: unknown) => unknown;
    encode?: (t: string) => number[];
  };
  (
    messages: unknown,
    options: Record<string, unknown>,
  ): Promise<Array<{ generated_text: Array<{ role: string; content: string }> }>>;
};

export interface InProcessProviderOptions {
  /**
   * Local models this provider exposes. Each entry becomes a
   * `ModelInfo` in the returned `ProviderMetadata.models[]`. Pipelines
   * are loaded lazily per model on the first invocation that names
   * them. Defaults to `[DEFAULT_LOCAL_MODEL]` when omitted.
   */
  readonly models?: readonly LocalModel[];
  /**
   * Override the provider id embedded in `ProviderMetadata.id` — useful
   * when you want two registrations of the same model set with
   * different capability declarations (e.g. one for routing, one for
   * extraction).
   */
  readonly providerId?: string;
  /**
   * Directory for downloaded model files, passed to transformers.js as
   * `cache_dir`. Defaults to transformers.js's own cache (`env.cacheDir`;
   * see `models.ts`).
   */
  readonly cacheDir?: string;
}

/**
 * Create an in-process `ModelProvider` backed by `@huggingface/transformers`.
 *
 * Pipelines are loaded lazily per model on the first `invoke()` call
 * that names them — construction of the provider is cheap. Model
 * weights download into the transformers.js cache (or `cacheDir`) on
 * first use; later loads read from the cache.
 *
 * Cost is always `0` USD (no external service). Resource-usage recording
 * still tracks token counts + duration so operators can see the local
 * model's real load in aggregate reports.
 *
 * The returned provider is safe to share process-wide; each underlying
 * pipeline serialises its own requests inside the ONNX runtime.
 */
export function createInProcessModelProvider(
  options: InProcessProviderOptions = {},
): ModelProvider {
  const modelKeys = options.models ?? [DEFAULT_LOCAL_MODEL];
  if (modelKeys.length === 0) {
    throw new Error('createInProcessModelProvider: `models` must not be empty.');
  }
  const providerId = options.providerId ?? `in-process/${modelKeys.join('+')}`;
  const metadata: ProviderMetadata = buildProviderMetadata(providerId, modelKeys);
  // Cache loaded pipelines per model key. Uses a Promise to dedupe
  // concurrent first-invocations on the same model.
  const pipelines = new Map<LocalModel, Promise<TextGenerationPipeline>>();

  function loadPipeline(modelKey: LocalModel): Promise<TextGenerationPipeline> {
    const cached = pipelines.get(modelKey);
    if (cached !== undefined) return cached;
    const spec = MODEL_SPECS[modelKey];
    const loading = (async (): Promise<TextGenerationPipeline> => {
      const mod = (await import('@huggingface/transformers')) as unknown as {
        pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;
      };
      return (await mod.pipeline('text-generation', spec.hfName, {
        dtype: spec.dtype,
        ...(options.cacheDir !== undefined && { cache_dir: options.cacheDir }),
      })) as TextGenerationPipeline;
    })();
    pipelines.set(modelKey, loading);
    return loading;
  }

  return {
    metadata,
    async invoke(input: ModelCallInput): Promise<ModelCallResult> {
      const modelKey = input.model as LocalModel;
      if (!modelKeys.includes(modelKey)) {
        throw new Error(
          `@kindgi/adapter-model-in-process: provider "${providerId}" does not expose model "${input.model}". ` +
            `Available: ${modelKeys.join(', ') || '<none>'}.`,
        );
      }
      const spec = MODEL_SPECS[modelKey];
      const p = await loadPipeline(modelKey);
      const messages = input.messages.map(toChatTemplateMessage);
      const startedAt = Date.now();

      const promptTokens = countPromptTokens(p, messages);

      const output = await p(messages, {
        max_new_tokens: input.maxOutputTokens ?? 512,
        do_sample: input.temperature !== undefined && input.temperature > 0,
        ...(input.temperature !== undefined &&
          input.temperature > 0 && {
            temperature: input.temperature,
          }),
        // No TextStreamer: `invoke` waits for the complete generation and
        // returns it in one result.
      });

      const durationMs = Date.now() - startedAt;
      const firstResult = output[0];
      const chat = firstResult?.generated_text ?? [];
      const assistantTurn = chat.at(-1);
      const responseText = assistantTurn?.content ?? '';
      const completionTokens = countTextTokens(p, responseText);
      void spec;

      return {
        message: { role: 'assistant', content: responseText },
        finishReason: 'stop',
        usage: { promptTokens, completionTokens },
        // In-process = zero direct USD cost. Ledger still records tokens.
        costUsd: 0,
        durationMs,
        provider: { id: providerId, model: modelKey },
      };
    },
  };
}

/**
 * Build `ProviderMetadata` from the set of local models this provider
 * exposes. Each `LocalModel` key maps to a `ModelInfo` entry —
 * `ModelInfo.name` is the key itself (short label), not the fully-
 * qualified Hugging Face model id, so provider listings (such as
 * `GET /v1/providers`) show `smollm2-360m` alongside vendor model ids.
 * Provider-level `attributes` are the union of every model's
 * `suitableFor` + `tier`, deduped, plus a marker `in-process`.
 */
function buildProviderMetadata(
  providerId: string,
  modelKeys: readonly LocalModel[],
): ProviderMetadata {
  const attributes = new Set<string>(['in-process']);
  for (const key of modelKeys) {
    const spec = MODEL_SPECS[key];
    for (const attr of spec.suitableFor) attributes.add(attr);
    attributes.add(spec.tier);
  }
  return {
    id: providerId,
    region: 'in-process',
    models: modelKeys.map((key) => buildModelInfo(key, MODEL_SPECS[key])),
    attributes: [...attributes],
    description:
      'Local models via @huggingface/transformers — routing / classification / smoke-test tier.',
  };
}

function buildModelInfo(key: LocalModel, spec: ModelSpec): ModelInfo {
  const features: Feature[] = ['streaming'];
  if (spec.toolUse) features.push('tool-use', 'structured-output');
  if (spec.contextWindow >= 32_000) features.push('long-context');
  return {
    name: key,
    contextWindow: spec.contextWindow,
    features,
    cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
    description: `Local ${spec.tier}-tier model (${spec.approxDownloadMb} MB, ${spec.contextWindow}-token context, HF id: ${spec.hfName}).`,
  };
}

/** Translate Kindgi ModelMessage → transformers.js Chat template message. */
function toChatTemplateMessage(m: ModelMessage): { role: string; content: string } {
  return { role: m.role, content: m.content };
}

/**
 * Token counting via the pipeline's tokenizer. Called before invocation
 * for prompt tokens and after for completion tokens. The tokenizer is
 * async-loaded with the pipeline; this must run after `loadPipeline()`.
 */
function countPromptTokens(
  p: TextGenerationPipeline,
  messages: readonly { role: string; content: string }[],
): number {
  const applyTemplate = p.tokenizer.apply_chat_template;
  if (typeof applyTemplate !== 'function') {
    return messages.reduce((sum, m) => sum + countTextTokens(p, m.content), 0);
  }
  try {
    const ids = applyTemplate(messages, {
      tokenize: true,
      add_generation_prompt: true,
    });
    return Array.isArray(ids) ? ids.length : 0;
  } catch {
    return messages.reduce((sum, m) => sum + countTextTokens(p, m.content), 0);
  }
}

function countTextTokens(p: TextGenerationPipeline, text: string): number {
  if (text.length === 0) return 0;
  const encode = p.tokenizer.encode;
  if (typeof encode !== 'function') {
    return Math.ceil(text.length / 4);
  }
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export type { LocalModel, ModelSpec } from './models.js';
export { MODEL_SPECS, DEFAULT_LOCAL_MODEL } from './models.js';
