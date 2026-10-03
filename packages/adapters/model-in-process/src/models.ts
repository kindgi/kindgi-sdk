// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Model registry — three selectable tiers, all Apache 2.0.
 *
 * Sizes are approximate q4f16 (4-bit quantization, float16 activations)
 * download sizes. The first `invoke()` naming a model (or a
 * `prepareInProcessModel` run for it) downloads the files into the
 * transformers.js cache; later loads read from the cache. The default
 * cache is transformers.js's own `env.cacheDir` — with
 * `@huggingface/transformers` 4.x, a `.cache` directory inside that
 * package's install location. The `cacheDir` option (provider and
 * prepare) is passed to the pipeline as `cache_dir` and redirects the
 * model files; transformers.js 4.3 can still write a model's
 * `config.json` to its default cache.
 *
 * Positioning per tier:
 *   - `smollm2-135m` — ultra-light. Routing, tag extraction, short
 *     classification, simple JSON. Do not use for reasoning or math.
 *   - `smollm2-360m` — default. Instruction-tuned with function-calling,
 *     summarisation and rewriting data. Best quality-per-megabyte in the
 *     tier.
 *   - `qwen3-0.6b` — highest local quality. Larger download; better on
 *     reasoning / longer contexts.
 */
export type LocalModel = 'smollm2-135m' | 'smollm2-360m' | 'qwen3-0.6b';

export interface ModelSpec {
  /** Hugging Face hub repo id — must have transformers.js-compatible ONNX assets. */
  readonly hfName: string;
  /** Approximate q4f16 download size in MB. */
  readonly approxDownloadMb: number;
  /** Model context window in tokens. */
  readonly contextWindow: number;
  /** Whether the model was tuned for tool / function-calling use. */
  readonly toolUse: boolean;
  /** Rough size tier — added to the provider's `attributes` and each model's `description`. */
  readonly tier: 'ultra-light' | 'small' | 'medium';
  /** Suitable-for hints for capability router preference matching. */
  readonly suitableFor: readonly string[];
  /** dtype passed to transformers.js pipeline. Balances quality vs size. */
  readonly dtype: 'q4f16' | 'q8' | 'fp16' | 'fp32';
}

export const MODEL_SPECS: Record<LocalModel, ModelSpec> = {
  'smollm2-135m': {
    hfName: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    approxDownloadMb: 118,
    contextWindow: 8192,
    toolUse: false,
    tier: 'ultra-light',
    suitableFor: ['routing', 'classification', 'smoke-test', 'local', 'lower-cost'],
    dtype: 'q4f16',
  },
  'smollm2-360m': {
    hfName: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    approxDownloadMb: 273,
    contextWindow: 8192,
    toolUse: true,
    tier: 'small',
    suitableFor: [
      'routing',
      'classification',
      'extraction',
      'summarization',
      'local',
      'lower-cost',
    ],
    dtype: 'q4f16',
  },
  'qwen3-0.6b': {
    hfName: 'onnx-community/Qwen3-0.6B-ONNX',
    approxDownloadMb: 550,
    contextWindow: 32_768,
    toolUse: true,
    tier: 'medium',
    suitableFor: ['reasoning', 'routing', 'classification', 'extraction', 'long-context', 'local'],
    dtype: 'q4f16',
  },
};

/** Default model when none supplied — best quality-per-MB in the tier. */
export const DEFAULT_LOCAL_MODEL: LocalModel = 'smollm2-360m';
