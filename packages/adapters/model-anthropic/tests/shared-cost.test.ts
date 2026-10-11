// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The shared package's `tokenCostUsd` (the formula the adapters built on it use) is the same
 * arithmetic as this adapter's `computeCostUsd`, with Anthropic's cache multipliers: held equal
 * on every model of the bundled preset, across plain, cached, cache-write and long-context usage,
 * so the two can't drift apart. Here, not in the shared package, which never depends on an
 * adapter.
 */

import { readFileSync } from 'node:fs';

import { tokenCostUsd } from '@kindgi/adapter-model-shared';
import type { ModelInfo, UsageCounters } from '@kindgi/capabilities';
import { describe, expect, test } from 'vitest';

import { computeCostUsd as anthropicCost } from '../src/index.js';

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
