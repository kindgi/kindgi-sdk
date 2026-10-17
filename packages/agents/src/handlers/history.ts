// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AppendMessageInput } from '../conversation-binding.js';
import { runUserId } from '../remember.js';
import type { ConversationMessage } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * The messages a turn's prompt carries as history: the newest
 * `conversationPolicy.historyLimit` before its user message, or all of
 * them without a limit. The binding reads only those (`beforeSequence`,
 * `last`); one that ignores the bounds returns every message, and the
 * window is kept here.
 */
export async function readHistory(ctx: TurnContext): Promise<readonly ConversationMessage[]> {
  const historyLimit = ctx.input.agent.conversationPolicy?.historyLimit;
  const before = ctx.userMessage?.sequence;
  const messages = await ctx.bindings.conversationBinding.readMessages({
    tenantId: ctx.input.tenantId,
    conversationId: ctx.input.conversationId,
    ...(before !== undefined && { beforeSequence: before }),
    ...(historyLimit !== undefined && { last: historyLimit }),
  });
  if (messages.kind === 'err') throwAgentTurnFailure(messages.error);
  // The user message just appended is the composer's last element, not history.
  const earlier = messages.value.filter((m) => before === undefined || m.sequence < before);
  return historyLimit === undefined
    ? earlier
    : earlier.slice(Math.max(0, earlier.length - historyLimit));
}

/**
 * Where the prompt's history starts: `same-conversation` recall reads
 * only older messages. `undefined` when the prompt carries the whole
 * conversation (no `historyLimit`).
 */
export async function historyStart(ctx: TurnContext): Promise<number | undefined> {
  if (ctx.input.agent.conversationPolicy?.historyLimit === undefined) return undefined;
  const history = await readHistory(ctx);
  return history[0]?.sequence ?? ctx.userMessage?.sequence;
}

/**
 * What the conversation-recall index keeps with a message this turn
 * appends (`AppendMessageInput.recall`): the user it acts for and the
 * run's segment path, which the conversation row doesn't have.
 */
export function recallOf(ctx: TurnContext): NonNullable<AppendMessageInput['recall']> {
  const userId = runUserId(ctx.input.principal);
  return {
    ...(userId !== undefined && { userId: userId as unknown as string }),
    ...(ctx.input.segments !== undefined && { segments: ctx.input.segments }),
  };
}
