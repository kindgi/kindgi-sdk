// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The two Gemini presets bill at Google's prices: Vertex AI's global ones for
 * `gemini`, the Gemini API's paid tier for `gemini-api`. Google bills a cached
 * prompt token at a tenth of the input price, past a long-context threshold
 * too, so each model sets `cachedPromptMultiplier`. Without it, the Gemini
 * adapter's default (0.25) prices cached tokens 2.5 times too high.
 */

import { describe, expect, test } from 'vitest';

import { type ProviderPreset, loadProviderPresets } from '../src/providers/preset-loader.js';

/** Per 1M tokens: input, cached input, output; then the threshold and those three past it. */
const pricesOf = (preset: ProviderPreset | undefined) =>
  Object.fromEntries(
    (preset?.metadata.models ?? []).map((model) => {
      const cost = model.cost as typeof model.cost & {
        readonly cachedPromptMultiplier?: number;
        readonly longContext?: {
          readonly thresholdTokens: number;
          readonly promptUsdPer1kTokens: number;
          readonly completionUsdPer1kTokens: number;
        };
      };
      const perM = (per1k: number) => Math.round(per1k * 1000 * 1e6) / 1e6;
      const cached = (per1k: number) =>
        cost.cachedPromptMultiplier === undefined
          ? 'no cachedPromptMultiplier'
          : perM(per1k * cost.cachedPromptMultiplier);
      const long = cost.longContext;
      return [
        model.name,
        [
          perM(cost.promptUsdPer1kTokens),
          cached(cost.promptUsdPer1kTokens),
          perM(cost.completionUsdPer1kTokens),
          ...(long === undefined
            ? []
            : [
                long.thresholdTokens,
                perM(long.promptUsdPer1kTokens),
                cached(long.promptUsdPer1kTokens),
                perM(long.completionUsdPer1kTokens),
              ]),
        ],
      ];
    }),
  );

describe("the Gemini presets' prices are Google's (pricing pages, checked 2026-11-07)", () => {
  test("gemini: Vertex AI's global prices, cached input at a tenth of input", async () => {
    const { gemini } = await loadProviderPresets();
    expect(pricesOf(gemini)).toEqual({
      'gemini-3.8-flash': [0.75, 0.075, 3.75],
      'gemini-3.5-flash-lite': [0.3, 0.03, 2.5],
    });
  });

  test("gemini-api: the Gemini API's paid tier, past 200K prompt tokens too", async () => {
    const { 'gemini-api': geminiApi } = await loadProviderPresets();
    expect(pricesOf(geminiApi)).toEqual({
      'gemini-3.8-flash': [0.75, 0.075, 3.75],
      'gemini-3.1-pro-preview': [2, 0.2, 12, 200000, 4, 0.4, 18],
      'gemini-3.5-flash-lite': [0.3, 0.03, 2.5],
    });
  });
});
