// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import OpenAI from 'openai';

import type { EmbeddingProvider } from '@kindgi/embedding';

import { OPENAI_COMPAT_ADAPTER_ID } from './provider.js';

/**
 * An embeddings endpoint that speaks OpenAI's `POST /embeddings`: OpenAI
 * itself, Ollama (`nomic-embed-text`), vLLM, Hugging Face TEI, LM Studio,
 * llama-server, a LiteLLM proxy. Same `baseURL` as for chat
 * (`BASE_URLS`), with the `/v1` suffix.
 */
export interface OpenAICompatEmbeddingOptions {
  readonly baseURL: string;
  /** The embedding model the endpoint serves (`text-embedding-3-small`, `nomic-embed-text`, …). */
  readonly model: string;
  /**
   * The key, or a resolver called before each request (a rotated key
   * takes effect on the next one). Absent: the endpoint takes none
   * (Ollama, a local TEI); the SDK sends a placeholder.
   */
  readonly apiKey?: string | (() => string | Promise<string>);
  /** The vector length, when known; otherwise learned by `probe()` or the first `embed()`. */
  readonly dimensions?: number;
  /** HTTP overrides passed through to the OpenAI SDK (`fetch`, `timeout`, `maxRetries`, …). */
  readonly clientOptions?: Omit<
    NonNullable<ConstructorParameters<typeof OpenAI>[0]>,
    'apiKey' | 'baseURL'
  >;
}

export interface OpenAICompatEmbeddingProvider extends EmbeddingProvider {
  /**
   * Embed a short text once: checks the endpoint answers with this model,
   * and learns the dimensions. Call it at boot, before `dimensions()`.
   */
  probe(): Promise<number>;
}

/** The SDK needs a non-empty key; endpoints that take none ignore it. */
const NO_KEY = 'unused';

/**
 * Create an `EmbeddingProvider` over an OpenAI-compatible embeddings
 * endpoint. The SDK client is built on first use (and rebuilt when the
 * key rotates), so construction has no side effects.
 */
export function createOpenAICompatEmbeddingProvider(
  options: OpenAICompatEmbeddingOptions,
): OpenAICompatEmbeddingProvider {
  let dims = options.dimensions;
  let cached: { readonly key: string; readonly client: OpenAI } | undefined;

  async function client(): Promise<OpenAI> {
    const resolved = typeof options.apiKey === 'function' ? await options.apiKey() : options.apiKey;
    const key = resolved === undefined || resolved === '' ? NO_KEY : resolved;
    if (cached !== undefined && cached.key === key) return cached.client;
    const fresh = new OpenAI({
      apiKey: key,
      baseURL: options.baseURL,
      ...(options.clientOptions ?? {}),
    });
    cached = { key, client: fresh };
    return fresh;
  }

  async function embed(text: string): Promise<Float32Array> {
    const response = await (await client()).embeddings.create({
      model: options.model,
      input: text,
      encoding_format: 'float',
    });
    const values = response.data[0]?.embedding;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(
        `${OPENAI_COMPAT_ADAPTER_ID}: the embeddings endpoint ${options.baseURL} returned no vector for model "${options.model}".`,
      );
    }
    if (dims === undefined) dims = values.length;
    if (values.length !== dims) {
      throw new Error(
        `${OPENAI_COMPAT_ADAPTER_ID}: model "${options.model}" returned a ${values.length}-dimension vector, expected ${dims}.`,
      );
    }
    return Float32Array.from(values);
  }

  return {
    embed,
    async probe() {
      return (await embed('dimension probe')).length;
    },
    dimensions() {
      if (dims === undefined) {
        throw new Error(
          `${OPENAI_COMPAT_ADAPTER_ID}: the dimensions of "${options.model}" aren't known yet; call probe() first.`,
        );
      }
      return dims;
    },
    describe() {
      return { name: OPENAI_COMPAT_ADAPTER_ID, version: '1', model: options.model };
    },
  };
}
