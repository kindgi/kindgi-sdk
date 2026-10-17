// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeContext, NodeHandler } from '@kindgi/handler';

import { runUserId } from '../remember.js';
import { type RetrievalPass, retrieveForTurn } from '../retrieval.js';
import { emitTurnEvent } from '../streaming.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { historyStart } from './history.js';
import { addRetrievalNodes } from './turn-provenance.js';

/**
 * Execute the agent's declared retrieval intents. Populates
 * `ctx.retrieved` for downstream prompt building + emits
 * `retrieval.completed`. Adds provenance nodes + edges when a builder
 * is wired. The journal keeps the facts (with each one's rank in each
 * search) and the intents that ran degraded.
 */
export function buildRunRetrievalsHandler(ctx: TurnContext): NodeHandler {
  return async (_input, kctx) => {
    if (ctx.conversation === undefined || ctx.userMessage === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'run-retrievals invoked before setup + persist-user-message completed',
        cause: null,
      });
    }
    const recorded = await recordedRetrievals(ctx, kctx);
    const pass = recorded ?? (await retrieveLive(ctx));
    const facts = pass.facts;
    ctx.retrieved = facts;
    ctx.recalled = pass.recalled;

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'retrieval.completed',
      count: facts.length,
      factIds: facts.map((r) => r.fact.id),
    });

    if (ctx.provenance !== undefined && ctx.userMessage !== undefined) {
      addRetrievalNodes(
        ctx.provenance,
        ctx.input.agent.retrieval,
        facts,
        ctx.userMessage,
        pass.recalled,
      );
    }

    // The facts and recalled messages go in the journal: a resumed turn
    // restores them from it (`rehydrateTurnContext`) rather than retrieving again.
    return {
      count: facts.length,
      retrieved: facts,
      ...(pass.recalled.length > 0 && { recalled: pass.recalled }),
      ...(pass.degraded.length > 0 && { degraded: pass.degraded }),
    };
  };
}

/**
 * A replay's retrievals: what the past run retrieved and recalled, when
 * the replay binding has them.
 */
async function recordedRetrievals(
  ctx: TurnContext,
  kctx: NodeContext,
): Promise<RetrievalPass | undefined> {
  const replay = ctx.input.replay;
  const binding = ctx.bindings.replay;
  if (replay === undefined || binding?.retrievals === undefined) return undefined;
  const ref = { tenantId: ctx.input.tenantId, runId: kctx.runId, replay };
  const facts = await binding.retrievals(ref);
  if (facts === undefined) return undefined;
  const recalled = (await binding.recalled?.(ref)) ?? [];
  return { facts, recalled, degraded: [] };
}

async function retrieveLive(ctx: TurnContext): Promise<RetrievalPass> {
  if (ctx.conversation === undefined) return { facts: [], recalled: [], degraded: [] };
  const userId = runUserId(ctx.input.principal);
  const recallsOlder = ctx.input.agent.retrieval.some(
    (i) => i.source === 'conversations' && i.scope === 'same-conversation',
  );
  const historyFrom = recallsOlder ? await historyStart(ctx) : undefined;
  const retrieved = await retrieveForTurn(
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
    {
      projectId: ctx.input.projectId,
      ...(ctx.input.orgId !== undefined && { orgId: ctx.input.orgId }),
      ...(ctx.input.participantId !== undefined && { participantId: ctx.input.participantId }),
      ...(userId !== undefined && { userId }),
      ...(ctx.input.segments !== undefined && { segments: ctx.input.segments }),
      ...(historyFrom !== undefined && { historyFrom }),
    },
  );
  if (retrieved.kind === 'err') throwAgentTurnFailure(retrieved.error);
  return retrieved.value;
}
