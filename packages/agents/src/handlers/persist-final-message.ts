// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeHandler } from '@kindgi/handler';
import type { NodeId, Timestamp } from '@kindgi/types';

import { AGENT_LOOP_NODE } from '../agent-turn-flow.js';
import { emitTurnEvent } from '../streaming.js';
import type { ConversationMessage } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { finalIteration } from './final-iteration.js';
import { recallOf } from './history.js';

/**
 * Persist the turn's terminal assistant message (non-intermediate —
 * increments `turnCount`). Runs after `evaluate-guardrails`, so only a
 * response that no `halt` guardrail rejected is stored. Reads the
 * response from the agent loop's output.
 *
 * Dry-run branch: skips the DB write; builds a synthetic
 * `ConversationMessage` with `sequence: -1`. `turnCount` is NOT
 * incremented (no persistence happened).
 */
export function buildPersistFinalMessageHandler(ctx: TurnContext): NodeHandler {
  return async (_input: unknown, kctx) => {
    const final = finalIteration(
      kctx.nodeOutputs.get(AGENT_LOOP_NODE as NodeId),
      'persist-final-message',
    );

    const assistantMsg = final.message;

    let finalMessage: ConversationMessage;
    if (kctx.dryRun) {
      finalMessage = {
        sequence: -1,
        role: 'agent',
        content: assistantMsg.content ?? '',
        createdAt: new Date().toISOString() as Timestamp,
        actor: ctx.input.agent.id,
      };
    } else {
      const persist = await ctx.bindings.conversationBinding.appendMessage({
        tenantId: ctx.input.tenantId,
        conversationId: ctx.input.conversationId,
        role: 'agent',
        content: assistantMsg.content ?? '',
        actor: ctx.input.agent.id,
        recall: recallOf(ctx),
      });
      if (persist.kind === 'err') throwAgentTurnFailure(persist.error);
      finalMessage = persist.value;
    }

    ctx.appended.push(finalMessage);
    ctx.finalMessage = finalMessage;

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'agent.message',
      step: ctx.usage.steps,
      isFinal: true,
      message: finalMessage,
    });

    return { sequence: finalMessage.sequence };
  };
}
