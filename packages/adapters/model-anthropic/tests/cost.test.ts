// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, test } from 'vitest';

import { computeCostUsd, toFrameworkUsage } from '../src/cost.js';

function usage(over: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ...over,
  } as Anthropic.Usage;
}

describe('computeCostUsd', () => {
  // Claude Haiku 5.5: $0.10 / $0.50 per 1M tokens, 5x past a 100,000-token prompt.
  const HAIKU_5_5 = {
    promptUsdPer1kTokens: 0.0001,
    completionUsdPer1kTokens: 0.0005,
    longContext: {
      thresholdTokens: 100_000,
      promptUsdPer1kTokens: 0.0005,
      completionUsdPer1kTokens: 0.0025,
    },
  };

  test('a prompt past the long-context threshold bills the whole call at the long rates, cache included', () => {
    // 90,000 regular + 20,000 cache-read = 110,000 prompt tokens: long.
    const cost = computeCostUsd(
      usage({ input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 1000 }),
      HAIKU_5_5,
    );
    expect(cost).toBeCloseTo((90_000 * 0.0005 + 20_000 * 0.0005 * 0.1 + 1000 * 0.0025) / 1000, 10);
  });

  test('a prompt at the threshold, or under it, bills at the base rates', () => {
    const cost = computeCostUsd(usage({ input_tokens: 100_000, output_tokens: 1000 }), HAIKU_5_5);
    expect(cost).toBeCloseTo((100_000 * 0.0001 + 1000 * 0.0005) / 1000, 10);
  });

  test('regular input + output tokens use base rates', () => {
    // 2000 in @ $0.003/1k = 0.006 ; 500 out @ $0.015/1k = 0.0075
    const cost = computeCostUsd(usage({ input_tokens: 2000, output_tokens: 500 }), {
      promptUsdPer1kTokens: 0.003,
      completionUsdPer1kTokens: 0.015,
    });
    expect(cost).toBeCloseTo(0.0135, 10);
  });

  test('cache-read tokens billed at default 0.1x multiplier', () => {
    // 1000 read @ (0.003 * 0.1) = 0.0003
    const cost = computeCostUsd(
      usage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000 }),
      { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
    );
    expect(cost).toBeCloseTo(0.0003, 10);
  });

  test('cache-creation tokens billed at default 1.25x multiplier (5-min tier)', () => {
    // 1000 created @ (0.003 * 1.25) = 0.00375
    const cost = computeCostUsd(
      usage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }),
      { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
    );
    expect(cost).toBeCloseTo(0.00375, 10);
  });

  test('creation multiplier override (1-hour tier at 2x)', () => {
    const cost = computeCostUsd(
      usage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }),
      {
        promptUsdPer1kTokens: 0.003,
        completionUsdPer1kTokens: 0.015,
        promptCacheCreationMultiplier: 2,
      },
    );
    expect(cost).toBeCloseTo(0.006, 10);
  });

  test('mixed regular + cache-creation + cache-read + output sums correctly', () => {
    // input=500 * 0.003/1k = 0.0015
    // creation=200 * 0.003 * 1.25 /1k = 0.00075
    // read=800 * 0.003 * 0.1 /1k = 0.00024
    // output=100 * 0.015/1k = 0.0015
    // total = 0.0015 + 0.00075 + 0.00024 + 0.0015 = 0.00399
    const cost = computeCostUsd(
      usage({
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 800,
      }),
      { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
    );
    expect(cost).toBeCloseTo(0.00399, 10);
  });

  test('null cache counters (older SDK responses) treated as zero', () => {
    const cost = computeCostUsd(
      usage({
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
      { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
    );
    // 1000 * 0.003/1k + 100 * 0.015/1k = 0.003 + 0.0015 = 0.0045
    expect(cost).toBeCloseTo(0.0045, 10);
  });
});

describe('toFrameworkUsage', () => {
  test('sums regular + cache-creation + cache-read into promptTokens', () => {
    const framework = toFrameworkUsage(
      usage({
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 800,
      }),
    );
    expect(framework).toEqual({
      promptTokens: 1500,
      completionTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
    });
  });

  test('cache counts the API reports as 0 are kept as 0', () => {
    const framework = toFrameworkUsage(
      usage({
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    );
    expect(framework).toEqual({
      promptTokens: 1000,
      completionTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test('no cache activity → no cache counts', () => {
    const framework = toFrameworkUsage(usage({ input_tokens: 1000, output_tokens: 100 }));
    expect(framework).toEqual({ promptTokens: 1000, completionTokens: 100 });
  });
});
