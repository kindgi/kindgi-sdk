// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type Anthropic from '@anthropic-ai/sdk';
import type { UsageCounters } from '@kindgi/capabilities';

/**
 * Cost multipliers for prompt-cache tokens. Anthropic prices cache
 * activity as a multiple of the base input rate:
 *
 *   - Cache creation (writing tokens to a new cache entry): 1.25x base
 *     for the 5-minute TTL tier, 2x for the 1-hour tier.
 *   - Cache read (reading tokens from an existing cache entry): 0.1x
 *     base.
 *
 * Defaults below match the 5-minute tier — the framework's
 * `ModelCallInput` doesn't distinguish TTLs, so callers using the
 * 1-hour cache tier should override
 * `promptCacheCreationMultiplier` at provider construction time.
 */
export const DEFAULT_CACHE_CREATION_MULTIPLIER_5MIN = 1.25;
export const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;

export interface CostRates {
  readonly promptUsdPer1kTokens: number;
  readonly completionUsdPer1kTokens: number;
  readonly promptCacheCreationMultiplier?: number;
  readonly promptCacheReadMultiplier?: number;
}

/**
 * Compute the USD cost of a single Anthropic invocation from the
 * response's `usage` object.
 *
 * Anthropic reports four token counters:
 *   - `input_tokens` — regular (uncached) input tokens
 *   - `output_tokens` — completion tokens
 *   - `cache_creation_input_tokens` — tokens WRITTEN to cache this
 *     request (billed at `input * creationMultiplier`)
 *   - `cache_read_input_tokens` — tokens READ from cache this request
 *     (billed at `input * readMultiplier`)
 *
 * `input_tokens` already excludes cache-read + cache-creation counts,
 * so we can sum the three input categories with their respective
 * rates without double-counting.
 */
export function computeCostUsd(usage: Anthropic.Usage, rates: CostRates): number {
  const inputRate = rates.promptUsdPer1kTokens;
  const outputRate = rates.completionUsdPer1kTokens;
  const creationMultiplier =
    rates.promptCacheCreationMultiplier ?? DEFAULT_CACHE_CREATION_MULTIPLIER_5MIN;
  const readMultiplier = rates.promptCacheReadMultiplier ?? DEFAULT_CACHE_READ_MULTIPLIER;

  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const inputCost =
    (inputTokens * inputRate +
      cacheCreation * inputRate * creationMultiplier +
      cacheRead * inputRate * readMultiplier) /
    1000;
  const outputCost = (outputTokens * outputRate) / 1000;

  return inputCost + outputCost;
}

/**
 * Anthropic's four-way token split as the framework's `UsageCounters`:
 *
 *   - `promptTokens` = every input token = regular + cache-write +
 *     cache-read (`input_tokens` excludes both cache counts);
 *   - `cacheReadTokens` / `cacheWriteTokens` = the cache's parts of it;
 *   - `completionTokens` = output tokens. Anthropic counts thinking in
 *     them and doesn't report it apart, so there's no `reasoningTokens`.
 */
export function toFrameworkUsage(usage: Anthropic.Usage): UsageCounters {
  const cacheWrite = usage.cache_creation_input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  return {
    promptTokens: usage.input_tokens + (cacheWrite ?? 0) + (cacheRead ?? 0),
    completionTokens: usage.output_tokens,
    // A part the vendor reports is kept, 0 included.
    ...(typeof cacheRead === 'number' && { cacheReadTokens: cacheRead }),
    ...(typeof cacheWrite === 'number' && { cacheWriteTokens: cacheWrite }),
  };
}
