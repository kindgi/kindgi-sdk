// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeHandler } from '@kindgi/handler';

import { runRetrievals } from '../retrieval.js';
import { emitTurnEvent } from '../streaming.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { addRetrievalNodes } from './turn-provenance.js';

/**
 * Execute the agent's declared retrieval intents. Populates
 * `ctx.retrieved` for downstream prompt building + emits
 * `retrieval.completed`. Adds provenance nodes + edges when a builder
 * is wired.
 */
export function buildRunRetrievalsHandler(ctx: TurnContext): NodeHandler {
  return async () => {
    if (ctx.conversation === undefined || ctx.userMessage === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'run-retrievals invoked before setup + persist-user-message completed',
        cause: null,
      });
    }
    const retrieved = await runRetrievals(
      ctx.input.agent,
      ctx.conversation,
      ctx.input.conversationId,
      ctx.input.userMessage,
      {
        memory: ctx.bindings.memoryBinding,
        ...(ctx.bindings.embeddingRegistry !== undefined && {
          embeddingRegistry: ctx.bindings.embeddingRegistry,
        }),
        ...(ctx.bindings.embeddingModel !== undefined && {
          embeddingModel: ctx.bindings.embeddingModel,
        }),
      },
    );
    if (retrieved.kind === 'err') throwAgentTurnFailure(retrieved.error);
    ctx.retrieved = retrieved.value;

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'retrieval.completed',
      count: retrieved.value.length,
      factIds: retrieved.value.map((r) => r.fact.id),
    });

    if (ctx.provenance !== undefined && ctx.userMessage !== undefined) {
      addRetrievalNodes(ctx.provenance, retrieved.value, ctx.userMessage);
    }

    // The facts go in the journal: a resumed turn restores them from it
    // (`rehydrateTurnContext`) rather than retrieving again.
    return { count: retrieved.value.length, retrieved: retrieved.value };
  };
}
