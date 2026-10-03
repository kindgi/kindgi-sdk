// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage, ModelToolCall } from '@kindgi/capabilities';
import type { NodeHandler } from '@kindgi/handler';

import { formatRetrievedForPrompt } from '../retrieval.js';
import type { ConversationMessage } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Compose the initial `modelMessages` array the loop's first iteration
 * feeds to the model:
 *
 *   [ system: rendered prompt,
 *     system: retrieved context (if any),
 *     ...history,
 *     user: current message ]
 *
 * Output shape: `{ nextMessages: ModelMessage[] }` — matches the loop
 * iteration output's `nextMessages` field so the loop body can treat
 * iteration 0's input identically to subsequent iterations'.
 */
export function buildBuildInitialMessagesHandler(ctx: TurnContext): NodeHandler {
  return async (input: unknown) => {
    if (ctx.conversation === undefined || ctx.retrieved === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'build-initial-messages invoked before setup / retrievals completed',
        cause: null,
      });
    }
    // `input` is `run-retrievals`'s output; discarded — the rendered
    // prompt is read from setup's sibling output via ctx (retained on
    // the closure by render-prompt through the local field `renderedPrompt`).
    void input;

    const historyLimit = ctx.input.agent.conversationPolicy?.historyLimit;
    const messages = await ctx.bindings.conversationBinding.readMessages({
      tenantId: ctx.input.tenantId,
      conversationId: ctx.input.conversationId,
    });
    if (messages.kind === 'err') throwAgentTurnFailure(messages.error);
    // The user message just appended is included in the history read;
    // drop it because the composer adds it explicitly as the last
    // element.
    const historyRaw = messages.value.filter((m) => m.sequence !== ctx.userMessage?.sequence);
    const history =
      historyLimit === undefined
        ? historyRaw
        : historyRaw.slice(Math.max(0, historyRaw.length - historyLimit));

    const contextBlock = formatRetrievedForPrompt(ctx.retrieved);
    const contextMessage: ModelMessage | undefined =
      contextBlock.length > 0 ? { role: 'system', content: contextBlock } : undefined;

    const rendered = ctx.renderedPrompt;
    if (rendered === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'build-initial-messages invoked before render-prompt completed',
        cause: null,
      });
    }

    const modelMessages: ModelMessage[] = [
      { role: 'system', content: rendered },
      ...(contextMessage !== undefined ? [contextMessage] : []),
      ...history.map(conversationToModelMessage),
      { role: 'user', content: ctx.input.userMessage },
    ];

    return { nextMessages: modelMessages };
  };
}

function conversationToModelMessage(msg: ConversationMessage): ModelMessage {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      ...(msg.toolCall !== undefined && { toolCallId: msg.toolCall.invocationId }),
    };
  }
  if (msg.role === 'agent' && typeof msg.content === 'object' && msg.content !== null) {
    const structured = msg.content as {
      readonly text?: string;
      readonly toolCalls?: readonly ModelToolCall[];
    };
    return {
      role: 'assistant',
      content: structured.text ?? '',
      ...(structured.toolCalls !== undefined && { toolCalls: structured.toolCalls }),
    };
  }
  const role: ModelMessage['role'] = msg.role === 'agent' ? 'assistant' : msg.role;
  return {
    role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  };
}
