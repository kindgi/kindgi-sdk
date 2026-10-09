// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage, ModelToolCall } from '@kindgi/capabilities';
import type { NodeHandler } from '@kindgi/handler';

import {
  MEMORY_DATA_RULE,
  formatPoliciesForPrompt,
  formatRetrievedForPrompt,
  isPolicyFact,
} from '../retrieval.js';
import type { ConversationMessage } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Compose the initial `modelMessages` array the loop's first iteration
 * feeds to the model:
 *
 *   [ system: rendered prompt
 *             (+ the memory rule, + "Policies (verified)", when there are),
 *     ...history,
 *     user: <memory> data block (if anything was retrieved),
 *     user: current message ]
 *
 * Retrieved facts are data: a labelled block in a user-role message, read
 * as information about the world, never as instructions. Only a verified
 * fact of a type the agent lists in `memory.instructionTypes` is an
 * instruction, in the system message.
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

    const agent = ctx.input.agent;
    const policies = ctx.retrieved.filter((r) => isPolicyFact(agent, r));
    const data = ctx.retrieved.filter((r) => !isPolicyFact(agent, r));
    const memoryBlock = formatRetrievedForPrompt(data);
    const memoryMessage: ModelMessage | undefined =
      memoryBlock.length > 0 ? { role: 'user', content: memoryBlock } : undefined;

    const rendered = ctx.renderedPrompt;
    if (rendered === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'build-initial-messages invoked before render-prompt completed',
        cause: null,
      });
    }

    const system = [
      rendered,
      ...(memoryMessage !== undefined ? [MEMORY_DATA_RULE] : []),
      ...(policies.length > 0 ? [formatPoliciesForPrompt(policies)] : []),
    ].join('\n\n');
    const modelMessages: ModelMessage[] = [
      { role: 'system', content: system },
      ...history.map(conversationToModelMessage),
      ...(memoryMessage !== undefined ? [memoryMessage] : []),
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
