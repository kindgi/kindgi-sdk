// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `tokenCostUsd`'s own cases. That it's the same arithmetic as the OpenAI-compatible and
 * Anthropic adapters' formulas is held in those adapters' tests (`shared-cost.test.ts`), since
 * this package never depends on an adapter.
 */

import type { ModelInfo } from '@kindgi/capabilities';
import { expect, test } from 'vitest';

import { tokenCostUsd } from '../src/index.js';

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
