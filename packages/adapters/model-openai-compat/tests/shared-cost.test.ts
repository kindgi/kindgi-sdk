// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The shared package's `tokenCostUsd` (the formula the adapters built on it use) is the same
 * arithmetic as this adapter's `computeCost`: held equal on every model of the bundled presets,
 * across plain, cached, cache-write, long-context and data-residency usage, so the two can't
 * drift apart. Here, not in the shared package, which never depends on an adapter.
 */

import { readFileSync } from 'node:fs';

import { tokenCostUsd } from '@kindgi/adapter-model-shared';
import type { ModelInfo, UsageCounters } from '@kindgi/capabilities';
import { describe, expect, test } from 'vitest';

import { computeCost as openAICompatCost } from '../src/index.js';

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
