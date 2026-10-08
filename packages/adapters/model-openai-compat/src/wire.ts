// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What both of the adapter's OpenAI APIs (Chat Completions and
 * Responses) share: tool names on the wire, tool-call arguments, cost.
 */

import type { ModelInfo, UsageCounters } from '@kindgi/capabilities';

/**
 * OpenAI (and every downstream compat endpoint — Ollama, vLLM, Groq,
 * OpenRouter, Together, Fireworks, LiteLLM, ...) constrains
 * `function.name` to `^[a-zA-Z0-9_-]{1,128}$` — dots are rejected.
 * The framework's tool id convention is `<pack>.<tool>`, so this
 * adapter transparently encodes on send and decodes on receive.
 *
 * See the sibling comment in
 * `packages/adapters/model-anthropic/src/translate.ts` — same
 * substitution (`.` → `__`), same reversibility caveat (authors
 * should not put literal `__` in tool ids).
 */
export function encodeToolName(name: string): string {
  return name.replace(/\./g, '__');
}

export function decodeToolName(name: string): string {
  return name.replace(/__/g, '.');
}

/** A tool call's JSON arguments as an object; `{}` when they don't parse. */
export function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * A model's rates, per 1K tokens, with the pricing extras an
 * OpenAI-compatible endpoint may have. The names are the ones the Gemini
 * and Anthropic adapters already price with.
 */
export interface OpenAICompatCostRates {
  readonly promptUsdPer1kTokens: number;
  readonly completionUsdPer1kTokens: number;
  /**
   * Cached prompt tokens' share of the prompt rate (OpenAI's GPT-6: 0.1;
   * GPT-6.1 Sol: 0.05). Absent: they bill at the prompt rate.
   */
  readonly cachedPromptMultiplier?: number;
  /**
   * Prompt tokens written to the cache, as a multiple of the prompt rate
   * (OpenAI's GPT-6: 1.25). Absent: they bill at the prompt rate.
   */
  readonly promptCacheCreationMultiplier?: number;
  /**
   * Long-context pricing: when a call's prompt (its cached and cache-write
   * tokens included) exceeds `thresholdTokens`, the whole call bills at
   * these rates, the cache multipliers applying to the long prompt rate
   * (OpenAI's GPT-6: twice the prompt and 1.5 times the completion rate
   * past 272,000 input tokens).
   */
  readonly longContext?: {
    readonly thresholdTokens: number;
    readonly promptUsdPer1kTokens: number;
    readonly completionUsdPer1kTokens: number;
  };
  /**
   * The uplift on a whole call sent to a data-residency host
   * (`eu.api.openai.com`: 1.1 for OpenAI models released on or after
   * 2026-03-05). Applied only on such a host.
   */
  readonly dataResidencyMultiplier?: number;
}

/** `ModelInfo` whose `cost` takes the rates in `OpenAICompatCostRates`. */
export interface OpenAICompatModelInfo extends ModelInfo {
  readonly cost: ModelInfo['cost'] & Omit<OpenAICompatCostRates, keyof ModelInfo['cost']>;
}

/**
 * A call's cost from its usage and the model's rates: cached and
 * cache-write prompt tokens at their multipliers, the whole call at the
 * long-context rates past their threshold, and a data-residency host's
 * uplift. A rate that isn't a finite, non-negative number is ignored (it
 * came from a registration stored before rates were checked).
 */
export function computeCost(
  modelInfo: ModelInfo,
  usage: UsageCounters,
  options: { readonly dataResidency?: boolean } = {},
): number {
  const cost = modelInfo.cost as Partial<Record<keyof OpenAICompatCostRates, unknown>>;
  const longContext = longContextOf(cost.longContext);
  const long =
    longContext !== undefined && usage.promptTokens > longContext.thresholdTokens
      ? longContext
      : undefined;
  const promptRate = long?.promptUsdPer1kTokens ?? modelInfo.cost.promptUsdPer1kTokens;
  const completionRate = long?.completionUsdPer1kTokens ?? modelInfo.cost.completionUsdPer1kTokens;
  const cached = usage.cacheReadTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.promptTokens - cached - written);
  const promptUnits =
    fresh +
    cached * (rateOf(cost.cachedPromptMultiplier) ?? 1) +
    written * (rateOf(cost.promptCacheCreationMultiplier) ?? 1);
  const total = (promptUnits * promptRate + usage.completionTokens * completionRate) / 1000;
  const uplift = options.dataResidency === true ? rateOf(cost.dataResidencyMultiplier) : undefined;
  return uplift !== undefined ? total * uplift : total;
}

function rateOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function longContextOf(value: unknown): OpenAICompatCostRates['longContext'] {
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
