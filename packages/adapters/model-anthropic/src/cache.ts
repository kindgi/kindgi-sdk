// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Prompt caching. Anthropic caches only the prompt prefixes a request
 * marks with `cache_control`, and a later request that starts with the
 * same bytes reads them at a fraction of the input price (0.1x; 0.05x on
 * Claude Opus 5.5 and Sonnet 5.5). A marked prefix costs 1.25x the first
 * time it's written. The prompt renders in the order tools, system,
 * messages, and the adapter marks up to three breakpoints:
 *
 *   - the last tool: the tool definitions, the same for every call an
 *     agent makes;
 *   - the first system block: the agent's own prompt. Later system blocks
 *     (retrieved context) change from turn to turn, so they stay after it;
 *   - the last block of the last message, when another call will re-send
 *     this prefix: a call with tools (the next step of a tool loop sends
 *     everything again plus the results) or a conversation with an earlier
 *     answer (its next turn does). A one-off call (no tools, no earlier
 *     answer, e.g. a judge) leaves its message unmarked: its tail is never
 *     sent again, so a write would only cost more.
 *
 * Each breakpoint uses the 5-minute cache (the default `ephemeral` TTL);
 * the steps of an agent turn are seconds apart. A prefix shorter than the
 * model's minimum (512 to 4,096 tokens) isn't cached and costs nothing
 * extra. How Anthropic keeps cached prompts, and their eligibility for
 * zero data retention: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * and https://platform.claude.com/docs/en/manage-claude/api-and-data-retention.
 */
export const PROMPT_CACHE: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

export interface CacheableRequest {
  /** The call's system messages, in order, each its own block. */
  readonly systemParts: readonly string[];
  readonly tools: readonly Anthropic.Tool[] | undefined;
  readonly messages: readonly Anthropic.MessageParam[];
}

export interface CachedRequest {
  readonly system: Anthropic.TextBlockParam[] | undefined;
  readonly tools: Anthropic.Tool[] | undefined;
  readonly messages: Anthropic.MessageParam[];
}

/** The request's parts, with the cache breakpoints above. The inputs aren't changed. */
export function withPromptCache(request: CacheableRequest): CachedRequest {
  const tools =
    request.tools === undefined || request.tools.length === 0
      ? undefined
      : request.tools.map((tool, i, all) =>
          i === all.length - 1 ? { ...tool, cache_control: PROMPT_CACHE } : tool,
        );
  const system =
    request.systemParts.length === 0
      ? undefined
      : request.systemParts.map(
          (text, i): Anthropic.TextBlockParam =>
            i === 0 ? { type: 'text', text, cache_control: PROMPT_CACHE } : { type: 'text', text },
        );
  const continues = tools !== undefined || request.messages.some((m) => m.role === 'assistant');
  const messages = continues ? markLastMessage(request.messages) : [...request.messages];
  return { system, tools, messages };
}

/**
 * The messages with a breakpoint on the last block of the last one that
 * can carry it: text (not empty), a tool call, a tool result.
 */
function markLastMessage(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (last === undefined) return out;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i] as Anthropic.ContentBlockParam;
    if (cacheable(block)) {
      blocks[i] = { ...block, cache_control: PROMPT_CACHE };
      out[out.length - 1] = { ...last, content: blocks };
      return out;
    }
  }
  return out;
}

function cacheable(
  block: Anthropic.ContentBlockParam,
): block is
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam {
  if (block.type === 'text') return block.text.length > 0;
  return block.type === 'tool_use' || block.type === 'tool_result';
}
