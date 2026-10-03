// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/dev-echo-provider` — the framework's first-party
 * deterministic `ModelProvider`.
 *
 * Emits a two-message script (tool-call → text) so an agent turn
 * completes in milliseconds with no LLM key and no network. This is a
 * DEV / TESTS / TUTORIAL surface only — every real deployment plugs in
 * the Anthropic model adapter (or an equivalent adapter) instead.
 *
 * Shape:
 *   - On the first invocation (no tool result in the message trail) it
 *     asks the runtime to call the FIRST tool from `input.tools` with
 *     `{ message: <last user message> }`. When the call declares no
 *     tools (a chat-only agent) it answers with the last user message
 *     itself — so a typed-output agent handed JSON gets that JSON back.
 *   - On the second invocation (post-tool) it emits a final assistant
 *     message: `Tool responded: <tool result>`.
 *
 * State lives per-invocation — the provider inspects the message trail,
 * not an instance variable, so it is safe to share across concurrent
 * runs.
 */

import type {
  ModelCallInput,
  ModelCallResult,
  ModelProvider,
  ProviderMetadata,
} from '@kindgi/capabilities';

export const DEV_ECHO_PROVIDER_ID = 'dev-echo';
export const DEV_ECHO_MODEL_NAME = 'dev-echo-v1';

const METADATA: ProviderMetadata = {
  id: DEV_ECHO_PROVIDER_ID,
  region: 'local',
  models: [
    {
      name: DEV_ECHO_MODEL_NAME,
      contextWindow: 200_000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
      description: 'Canned scripted response — no LLM, deterministic.',
    },
  ],
  description:
    'Dev-only deterministic provider — no LLM, canned scripted responses. NEVER for production.',
  // Serves only when no other provider fits, so registering a real model
  // takes over without removing this one.
  fallback: true,
};

const TOOL_CALL_ID = 'dev-echo-call-1';

function lastUserMessage(input: ModelCallInput): string {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const m = input.messages[i];
    if (m !== undefined && m.role === 'user') return m.content;
  }
  return '';
}

function lastToolResult(input: ModelCallInput): string | null {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const m = input.messages[i];
    if (m !== undefined && m.role === 'tool') return m.content;
  }
  return null;
}

/**
 * Build the deterministic dev-echo provider. The returned value is a
 * plain `ModelProvider` — pass it to `createProviderRegistry([...])` or
 * plug it into any other seam the framework exposes.
 */
export function createDevEchoProvider(): ModelProvider {
  return {
    metadata: METADATA,
    async invoke(input: ModelCallInput): Promise<ModelCallResult> {
      const toolResult = lastToolResult(input);
      const toolName = input.tools?.[0]?.name;
      if (toolResult === null && toolName === undefined) {
        return {
          message: { role: 'assistant', content: lastUserMessage(input) },
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 6 },
          costUsd: 0,
          durationMs: 1,
          provider: { id: METADATA.id, model: DEV_ECHO_MODEL_NAME },
        };
      }
      if (toolResult === null && toolName !== undefined) {
        const userText = lastUserMessage(input);
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: TOOL_CALL_ID,
                name: toolName,
                arguments: { message: userText },
              },
            ],
          },
          finishReason: 'tool-use',
          usage: { promptTokens: 20, completionTokens: 6 },
          costUsd: 0,
          durationMs: 1,
          provider: { id: METADATA.id, model: DEV_ECHO_MODEL_NAME },
        };
      }
      return {
        message: {
          role: 'assistant',
          content: `Tool responded: ${toolResult}`,
        },
        finishReason: 'stop',
        usage: { promptTokens: 30, completionTokens: 12 },
        costUsd: 0,
        durationMs: 1,
        provider: { id: METADATA.id, model: DEV_ECHO_MODEL_NAME },
      };
    },
  };
}

/**
 * Reserved for callers that want to reason about the metadata without
 * instantiating the provider (e.g. banner text, tests, docs). The
 * concrete provider instance always exposes the same `metadata`.
 */
export const DEV_ECHO_PROVIDER_METADATA: ProviderMetadata = METADATA;
