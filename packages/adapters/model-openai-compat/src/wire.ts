// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What both of the adapter's OpenAI APIs (Chat Completions and
 * Responses) share: tool names on the wire, tool-call arguments, cost.
 */

import type { ModelInfo } from '@kindgi/capabilities';

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

export function computeCost(
  modelInfo: ModelInfo,
  promptTokens: number,
  completionTokens: number,
): number {
  const promptCost = (promptTokens / 1000) * modelInfo.cost.promptUsdPer1kTokens;
  const completionCost = (completionTokens / 1000) * modelInfo.cost.completionUsdPer1kTokens;
  return promptCost + completionCost;
}
