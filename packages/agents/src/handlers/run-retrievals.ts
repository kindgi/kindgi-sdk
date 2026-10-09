// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeContext, NodeHandler } from '@kindgi/handler';

import { runUserId } from '../remember.js';
import { type DegradedIntent, retrieveForTurn } from '../retrieval.js';
import { emitTurnEvent } from '../streaming.js';
import type { RetrievedFact } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
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
    const pass =
      recorded !== undefined ? { facts: recorded, degraded: [] } : await retrieveLive(ctx);
    const facts = pass.facts;
    ctx.retrieved = facts;

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'retrieval.completed',
      count: facts.length,
      factIds: facts.map((r) => r.fact.id),
    });

    if (ctx.provenance !== undefined && ctx.userMessage !== undefined) {
      addRetrievalNodes(ctx.provenance, ctx.input.agent.retrieval, facts, ctx.userMessage);
    }

    // The facts go in the journal: a resumed turn restores them from it
    // (`rehydrateTurnContext`) rather than retrieving again.
    return {
      count: facts.length,
      retrieved: facts,
      ...(pass.degraded.length > 0 && { degraded: pass.degraded }),
    };
  };
}

/** A replay's retrievals: what the past run retrieved, when the replay binding has it. */
async function recordedRetrievals(
  ctx: TurnContext,
  kctx: NodeContext,
): Promise<readonly RetrievedFact[] | undefined> {
  const replay = ctx.input.replay;
  if (replay === undefined || ctx.bindings.replay?.retrievals === undefined) return undefined;
  return ctx.bindings.replay.retrievals({
    tenantId: ctx.input.tenantId,
    runId: kctx.runId,
    replay,
  });
}

async function retrieveLive(ctx: TurnContext): Promise<{
  readonly facts: readonly RetrievedFact[];
  readonly degraded: readonly DegradedIntent[];
}> {
  if (ctx.conversation === undefined) return { facts: [], degraded: [] };
  const userId = runUserId(ctx.input.principal);
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
    },
  );
  if (retrieved.kind === 'err') throwAgentTurnFailure(retrieved.error);
  return retrieved.value;
}
