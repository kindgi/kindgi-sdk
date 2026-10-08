// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a call costs: cached and cache-write prompt tokens at their
 * multipliers, the whole call at the long-context rates past the
 * threshold, and a data-residency host's uplift. Checked against OpenAI's
 * GPT-6.1 Sol prices per 1M tokens (pricing page, 2026-10-07): input $2,
 * cached $0.10, cache writes $2.50, output $10; past 272,000 input tokens
 * $4 / $0.20 / $5 / $15; data-residency hosts +10%.
 */

import { describe, expect, test } from 'vitest';

import type { ModelInfo, ProviderMetadata, UsageCounters } from '@kindgi/capabilities';

import {
  BASE_URLS,
  type OpenAICompatModelInfo,
  computeCost,
  createOpenAICompatModelProvider,
  isDataResidencyHost,
} from '../src/index.js';

const SOL: OpenAICompatModelInfo = {
  name: 'gpt-6.1-sol',
  contextWindow: 1050000,
  features: ['tool-use'],
  cost: {
    promptUsdPer1kTokens: 0.002,
    completionUsdPer1kTokens: 0.01,
    cachedPromptMultiplier: 0.05,
    promptCacheCreationMultiplier: 1.25,
    longContext: {
      thresholdTokens: 272000,
      promptUsdPer1kTokens: 0.004,
      completionUsdPer1kTokens: 0.015,
    },
    dataResidencyMultiplier: 1.1,
  },
};

/** Dollars per 1M tokens, so the expectations read like the pricing page. */
const perM = (tokens: number, usdPer1M: number) => (tokens * usdPer1M) / 1_000_000;

const usage = (over: Partial<UsageCounters>): UsageCounters => ({
  promptTokens: 0,
  completionTokens: 0,
  ...over,
});

describe('computeCost prices a call as OpenAI bills it', () => {
  test('fresh prompt and completion tokens at the base rates', () => {
    expect(computeCost(SOL, usage({ promptTokens: 10_000, completionTokens: 1_000 }))).toBeCloseTo(
      perM(10_000, 2) + perM(1_000, 10),
      12,
    );
  });

  test('cached prompt tokens at their share of the prompt rate', () => {
    const cost = computeCost(
      SOL,
      usage({ promptTokens: 10_000, cacheReadTokens: 8_000, completionTokens: 1_000 }),
    );
    expect(cost).toBeCloseTo(perM(2_000, 2) + perM(8_000, 0.1) + perM(1_000, 10), 12);
  });

  test('cache-write prompt tokens at their multiple of the prompt rate', () => {
    const cost = computeCost(
      SOL,
      usage({ promptTokens: 10_000, cacheWriteTokens: 4_000, completionTokens: 0 }),
    );
    expect(cost).toBeCloseTo(perM(6_000, 2) + perM(4_000, 2.5), 12);
  });

  test('past 272,000 prompt tokens (cached ones included), the whole call at the long rates', () => {
    const long = usage({
      promptTokens: 300_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 50_000,
      completionTokens: 2_000,
    });
    expect(computeCost(SOL, long)).toBeCloseTo(
      perM(150_000, 4) + perM(100_000, 0.2) + perM(50_000, 5) + perM(2_000, 15),
      12,
    );
    // At the threshold itself it's still short.
    expect(computeCost(SOL, usage({ promptTokens: 272_000, completionTokens: 1_000 }))).toBeCloseTo(
      perM(272_000, 2) + perM(1_000, 10),
      12,
    );
  });

  test("a data-residency host's uplift applies to the whole call, and only there", () => {
    const call = usage({ promptTokens: 10_000, cacheReadTokens: 8_000, completionTokens: 1_000 });
    const base = perM(2_000, 2) + perM(8_000, 0.1) + perM(1_000, 10);
    expect(computeCost(SOL, call, { dataResidency: true })).toBeCloseTo(base * 1.1, 12);
    expect(computeCost(SOL, call, { dataResidency: false })).toBeCloseTo(base, 12);
    expect(isDataResidencyHost('https://eu.api.openai.com/v1')).toBe(true);
    expect(isDataResidencyHost(BASE_URLS.OPENAI)).toBe(false);
    expect(isDataResidencyHost('https://eu.api.openai.com.acme.test/v1')).toBe(false);
    expect(isDataResidencyHost('https://acmeapi.openai.com/v1')).toBe(false);
    expect(isDataResidencyHost(BASE_URLS.GROQ)).toBe(false);
  });

  test('a model with only the base rates prices every prompt token at the prompt rate', () => {
    const plain: ModelInfo = {
      ...SOL,
      cost: { promptUsdPer1kTokens: 0.002, completionUsdPer1kTokens: 0.01 },
    };
    const call = usage({
      promptTokens: 300_000,
      cacheReadTokens: 100_000,
      completionTokens: 1_000,
    });
    expect(computeCost(plain, call, { dataResidency: true })).toBeCloseTo(
      perM(300_000, 2) + perM(1_000, 10),
      12,
    );
  });

  test("rates that aren't finite, non-negative numbers are ignored", () => {
    const stored = {
      ...SOL,
      cost: {
        promptUsdPer1kTokens: 0.002,
        completionUsdPer1kTokens: 0.01,
        cachedPromptMultiplier: -1,
        promptCacheCreationMultiplier: 'x',
        longContext: { thresholdTokens: 272000, promptUsdPer1kTokens: 0.004 },
        dataResidencyMultiplier: Number.POSITIVE_INFINITY,
      },
    } as unknown as ModelInfo;
    const call = usage({
      promptTokens: 300_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 50_000,
      completionTokens: 1_000,
    });
    expect(computeCost(stored, call, { dataResidency: true })).toBeCloseTo(
      perM(300_000, 2) + perM(1_000, 10),
      12,
    );
  });
});

describe('both paths price with the model rates and their host', () => {
  const metadata: ProviderMetadata = { id: 'openai', region: 'unspecified', models: [SOL] };
  const call = { model: 'gpt-6.1-sol', messages: [{ role: 'user' as const, content: 'hi' }] };
  const answering = (body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

  test('Responses: cached and cache-write tokens from the usage; the EU host pays the uplift', async () => {
    const body = {
      id: 'resp_1',
      object: 'response',
      created_at: 0,
      status: 'completed',
      error: null,
      incomplete_details: null,
      model: 'gpt-6.1-sol',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hi', annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 10_000,
        input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_000 },
        output_tokens: 1_000,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 11_000,
      },
    };
    const expected = perM(1_000, 2) + perM(8_000, 0.1) + perM(1_000, 2.5) + perM(1_000, 10);
    for (const [baseURL, uplift] of [
      [BASE_URLS.OPENAI, 1],
      ['https://eu.api.openai.com/v1', 1.1],
    ] as const) {
      const result = await createOpenAICompatModelProvider({
        baseURL,
        apiKey: 'k',
        metadata,
        clientOptions: { fetch: answering(body), maxRetries: 0 },
      }).invoke(call);
      expect(result.costUsd).toBeCloseTo(expected * uplift, 12);
    }
  });

  test('Chat Completions: cached tokens from prompt_tokens_details', async () => {
    const result = await createOpenAICompatModelProvider({
      baseURL: BASE_URLS.OPENAI,
      api: 'chat-completions',
      apiKey: 'k',
      metadata,
      clientOptions: {
        fetch: answering({
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-6.1-sol',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
          usage: {
            prompt_tokens: 10_000,
            completion_tokens: 1_000,
            total_tokens: 11_000,
            prompt_tokens_details: { cached_tokens: 8_000 },
          },
        }),
        maxRetries: 0,
      },
    }).invoke(call);
    expect(result.costUsd).toBeCloseTo(perM(2_000, 2) + perM(8_000, 0.1) + perM(1_000, 10), 12);
  });
});
