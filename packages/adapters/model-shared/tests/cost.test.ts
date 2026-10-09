// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `tokenCostUsd` is the same arithmetic as the OpenAI-compatible and Anthropic adapters' own
 * formulas: held equal on every model of the bundled presets, across plain, cached, cache-write,
 * long-context and data-residency usage, so the formulas can't drift apart.
 */

import { readFileSync } from 'node:fs';

import { computeCostUsd as anthropicCost } from '@kindgi/adapter-model-anthropic';
import { computeCost as openAICompatCost } from '@kindgi/adapter-model-openai-compat';
import type { ModelInfo, UsageCounters } from '@kindgi/capabilities';
import { describe, expect, test } from 'vitest';

import { tokenCostUsd } from '../src/index.js';

const PRESETS = new URL('../../../cli/src/providers/presets/', import.meta.url);
const modelsOf = (preset: string): readonly ModelInfo[] =>
  JSON.parse(readFileSync(new URL(`${preset}.json`, PRESETS), 'utf8')).metadata.models;

const USAGES: readonly UsageCounters[] = [
  { promptTokens: 1200, completionTokens: 300 },
  { promptTokens: 9000, completionTokens: 400, cacheReadTokens: 8000 },
  { promptTokens: 9000, completionTokens: 400, cacheWriteTokens: 8000 },
  { promptTokens: 9000, completionTokens: 400, cacheReadTokens: 5000, cacheWriteTokens: 3000 },
  { promptTokens: 400_000, completionTokens: 2000, cacheReadTokens: 100_000 },
];

describe('equal to the OpenAI-compatible adapter (a missing multiplier is the prompt rate)', () => {
  for (const preset of ['openai', 'groq', 'openrouter']) {
    for (const model of modelsOf(preset)) {
      test(`${preset} ${model.name}`, () => {
        for (const usage of USAGES) {
          expect(tokenCostUsd(model, usage)).toBeCloseTo(openAICompatCost(model, usage), 12);
          expect(tokenCostUsd(model, usage, { dataResidency: true })).toBeCloseTo(
            openAICompatCost(model, usage, { dataResidency: true }),
            12,
          );
        }
      });
    }
  }
});

describe('equal to the Anthropic adapter (missing multipliers: reads 0.1, writes 1.25)', () => {
  for (const model of modelsOf('anthropic')) {
    test(`anthropic ${model.name}`, () => {
      for (const usage of USAGES) {
        const read = usage.cacheReadTokens ?? 0;
        const written = usage.cacheWriteTokens ?? 0;
        const anthropicUsage = {
          input_tokens: usage.promptTokens - read - written,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: written,
          output_tokens: usage.completionTokens,
        };
        expect(
          tokenCostUsd(model, usage, { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }),
        ).toBeCloseTo(anthropicCost(anthropicUsage as never, model.cost as never), 12);
      }
    });
  }
});

test('the long-context tier bills the whole call at its rates, the cache multipliers on its prompt rate', () => {
  const model = {
    name: 'm',
    contextWindow: 1_000_000,
    features: [],
    cost: {
      promptUsdPer1kTokens: 0.002,
      completionUsdPer1kTokens: 0.01,
      cachedPromptMultiplier: 0.1,
      longContext: {
        thresholdTokens: 200_000,
        promptUsdPer1kTokens: 0.004,
        completionUsdPer1kTokens: 0.015,
      },
    },
  } as unknown as ModelInfo;
  const usage = { promptTokens: 300_000, completionTokens: 1000, cacheReadTokens: 100_000 };
  expect(tokenCostUsd(model, usage)).toBeCloseTo(
    (200_000 * 0.004 + 100_000 * 0.004 * 0.1 + 1000 * 0.015) / 1000,
    12,
  );
});
