// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { ModelInfo, UsageCounters } from '@kindgi/capabilities';

/**
 * Cached prompt tokens bill at this fraction of the prompt rate unless a
 * model says otherwise — Gemini 2.5's implicit-cache discount (75% off).
 */
export const DEFAULT_CACHED_PROMPT_MULTIPLIER = 0.25;

/** A model's rates, per 1K tokens, with Gemini's two pricing extras. */
export interface GeminiCostRates {
  readonly promptUsdPer1kTokens: number;
  readonly completionUsdPer1kTokens: number;
  /** Cached prompt tokens' share of the prompt rate. Default 0.25. */
  readonly cachedPromptMultiplier?: number;
  /**
   * Long-context pricing: when a call's prompt exceeds `thresholdTokens`,
   * the whole call bills at these rates (Gemini 2.5 Pro doubles above
   * 200K prompt tokens, for example).
   */
  readonly longContext?: {
    readonly thresholdTokens: number;
    readonly promptUsdPer1kTokens: number;
    readonly completionUsdPer1kTokens: number;
  };
}

/** `ModelInfo` whose `cost` takes Gemini's cached-token and long-context rates. */
export interface GeminiModelInfo extends ModelInfo {
  readonly cost: ModelInfo['cost'] & Omit<GeminiCostRates, keyof ModelInfo['cost']>;
}

/**
 * Gemini's usage as the framework's counters:
 *   - `promptTokens` includes the cached tokens and the tokens of
 *     built-in tool prompts; `cacheReadTokens` = the cached part. Gemini
 *     writes a cache in a call of its own, so there's no
 *     `cacheWriteTokens`;
 *   - thinking bills as output, so `completionTokens` includes it, and
 *     `reasoningTokens` is that part.
 */
export function toFrameworkUsage(
  usage: GenerateContentResponseUsageMetadata | undefined,
): UsageCounters {
  const cached = usage?.cachedContentTokenCount ?? 0;
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  return {
    promptTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    completionTokens: (usage?.candidatesTokenCount ?? 0) + thoughts,
    ...(cached > 0 && { cacheReadTokens: cached }),
    ...(thoughts > 0 && { reasoningTokens: thoughts }),
  };
}

/**
 * A call's cost in USD: uncached prompt tokens at the prompt rate, cached
 * ones at the cached share of it, completion (thinking included) at the
 * completion rate — the long-context rates when the prompt is past the
 * model's threshold.
 */
export function computeCostUsd(usage: UsageCounters, rates: GeminiCostRates): number {
  const long =
    rates.longContext !== undefined && usage.promptTokens > rates.longContext.thresholdTokens
      ? rates.longContext
      : undefined;
  const promptRate = long?.promptUsdPer1kTokens ?? rates.promptUsdPer1kTokens;
  const completionRate = long?.completionUsdPer1kTokens ?? rates.completionUsdPer1kTokens;
  const cached = usage.cacheReadTokens ?? 0;
  const multiplier = rates.cachedPromptMultiplier ?? DEFAULT_CACHED_PROMPT_MULTIPLIER;
  return (
    ((usage.promptTokens - cached) * promptRate +
      cached * promptRate * multiplier +
      usage.completionTokens * completionRate) /
    1000
  );
}
