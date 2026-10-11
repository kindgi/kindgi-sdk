// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A call's cost from its usage and the model's registered rates, for adapters whose vendor
 * bills by tokens: prompt and completion rates per 1,000 tokens, cache reads and writes as
 * multiples of the prompt rate, a long-context tier, and a data-residency uplift. The same
 * arithmetic as the OpenAI-compatible and Anthropic adapters' own formulas (a test holds the
 * three equal on the bundled presets); what differs between vendors is only what a missing
 * multiplier means, which each adapter says (`TokenCostOptions`).
 */

import type { ModelInfo, UsageCounters } from '@kindgi/capabilities';

export interface TokenCostOptions {
  /**
   * Cache reads' multiple of the prompt rate when the model's cost names none
   * (`cachedPromptMultiplier`, or `promptCacheReadMultiplier`). Default 1: the prompt rate,
   * as OpenAI bills; Anthropic's adapters pass 0.1.
   */
  readonly cacheReadMultiplier?: number;
  /**
   * Cache writes' multiple of the prompt rate when the model's cost names none
   * (`promptCacheCreationMultiplier`). Default 1; Anthropic's adapters pass 1.25 (the
   * 5-minute cache).
   */
  readonly cacheWriteMultiplier?: number;
  /** The call went to a data-residency endpoint: the model's `dataResidencyMultiplier` applies. */
  readonly dataResidency?: boolean;
}

/**
 * USD for one call. `usage.promptTokens` includes the cache reads and writes; a prompt past
 * the model's `longContext.thresholdTokens` bills the whole call at the long rates, the
 * cache multipliers applying to the long prompt rate.
 */
export function tokenCostUsd(
  model: ModelInfo,
  usage: UsageCounters,
  options: TokenCostOptions = {},
): number {
  const cost = model.cost as Partial<Record<string, unknown>>;
  const long = longContextOf(cost.longContext);
  const tier = long !== undefined && usage.promptTokens > long.thresholdTokens ? long : undefined;
  const promptRate = tier?.promptUsdPer1kTokens ?? model.cost.promptUsdPer1kTokens;
  const completionRate = tier?.completionUsdPer1kTokens ?? model.cost.completionUsdPer1kTokens;
  const readMultiplier =
    rateOf(cost.cachedPromptMultiplier) ??
    rateOf(cost.promptCacheReadMultiplier) ??
    options.cacheReadMultiplier ??
    1;
  const writeMultiplier =
    rateOf(cost.promptCacheCreationMultiplier) ?? options.cacheWriteMultiplier ?? 1;
  const read = usage.cacheReadTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.promptTokens - read - written);
  const promptUnits = fresh + read * readMultiplier + written * writeMultiplier;
  const total = (promptUnits * promptRate + usage.completionTokens * completionRate) / 1000;
  const uplift = options.dataResidency === true ? rateOf(cost.dataResidencyMultiplier) : undefined;
  return uplift !== undefined ? total * uplift : total;
}

function rateOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function longContextOf(
  value: unknown,
):
  | { thresholdTokens: number; promptUsdPer1kTokens: number; completionUsdPer1kTokens: number }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const tier = value as Record<string, unknown>;
  const thresholdTokens = rateOf(tier.thresholdTokens);
  const promptUsdPer1kTokens = rateOf(tier.promptUsdPer1kTokens);
  const completionUsdPer1kTokens = rateOf(tier.completionUsdPer1kTokens);
  return thresholdTokens !== undefined &&
    promptUsdPer1kTokens !== undefined &&
    completionUsdPer1kTokens !== undefined
    ? { thresholdTokens, promptUsdPer1kTokens, completionUsdPer1kTokens }
    : undefined;
}
