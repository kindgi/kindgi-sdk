// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelCallInput, ModelMessage } from '@kindgi/capabilities';
import type { NodeHandler } from '@kindgi/handler';

import { emitTurnEvent } from '../streaming.js';

import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Loop-body node #1. Invoke the model with the current
 * `nextMessages` accumulator. Emits `model.call.started` +
 * `model.call.completed`, records provenance for the model-call node,
 * and accumulates usage on `ctx.usage`.
 *
 * Output is a partial `AgentTurnIterationOutput` — `dispatch-tools`
 * receives it and finishes composing the iteration output.
 */
export function buildModelCallHandler(ctx: TurnContext): NodeHandler {
  return async (input: unknown, kctx) => {
    if (ctx.provider === undefined || ctx.model === undefined || ctx.tools === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'model-call invoked before setup completed',
        cause: null,
      });
    }
    const shaped = input as { readonly nextMessages?: readonly ModelMessage[] } | undefined;
    const nextMessages: readonly ModelMessage[] = shaped?.nextMessages ?? [];

    ctx.usage.steps += 1;

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'model.call.started',
      step: ctx.usage.steps,
      providerId: ctx.provider.metadata.id,
      model: ctx.model.name,
    });

    let callResult: Awaited<ReturnType<typeof ctx.provider.invoke>>;
    if (kctx.dryRun) {
      // Dry-run: skip the network call. Return a schema-conformant
      // mock indicating the model would have terminated cleanly. The
      // mock requests no tools, so a dry run does not preview tool
      // planning.
      callResult = {
        finishReason: 'stop',
        message: { role: 'assistant', content: '[dry-run: model call skipped]' },
        usage: { promptTokens: 0, completionTokens: 0 },
        costUsd: 0,
        durationMs: 0,
        provider: { id: ctx.provider.metadata.id, model: ctx.model.name },
      };
    } else {
      const callInput: ModelCallInput = {
        model: ctx.model.name,
        messages: nextMessages,
        ...(ctx.tools.definitions.length > 0 && {
          tools: ctx.tools.definitions,
        }),
        abortSignal: ctx.turnAbort.signal,
      };

      try {
        callResult = await ctx.provider.invoke(callInput);
      } catch (cause) {
        if (ctx.turnAbort.signal.aborted) {
          throwAgentTurnFailure({
            code: 'agent-turn-aborted',
            message: `Agent turn aborted: ${cause instanceof Error ? cause.message : String(cause)}`,
            reason: ctx.abortReason ?? 'timeout',
          });
        }
        // The provider's own words (a 401's "invalid x-api-key", a 429)
        // are what the caller needs; they're in `cause` too, but callers
        // show `message`.
        throwAgentTurnFailure({
          code: 'model-invocation-failed',
          message: `Model call to ${ctx.provider.metadata.id} (${ctx.model.name}) failed: ${describeCause(cause)}`,
          cause,
        });
      }
    }

    ctx.usage.promptTokens += callResult.usage.promptTokens;
    ctx.usage.completionTokens += callResult.usage.completionTokens;
    ctx.usage.totalCostUsd += callResult.costUsd;
    ctx.lastProvider = callResult.provider;

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'model.call.completed',
      step: ctx.usage.steps,
      finishReason: callResult.finishReason,
      promptTokens: callResult.usage.promptTokens,
      completionTokens: callResult.usage.completionTokens,
      costUsd: callResult.costUsd,
      durationMs: callResult.durationMs,
    });

    if (ctx.provenance !== undefined && ctx.userMessage !== undefined) {
      const modelCallNodeId = `model-call:${ctx.usage.steps}`;
      ctx.provenance.addNode({
        id: modelCallNodeId,
        kind: 'model-call',
        timestamp: new Date().toISOString() as never,
        modelVersion: `${callResult.provider.id}/${callResult.provider.model}`,
        attributes: {
          step: ctx.usage.steps,
          promptTokens: callResult.usage.promptTokens,
          completionTokens: callResult.usage.completionTokens,
          costUsd: callResult.costUsd,
          finishReason: callResult.finishReason,
        },
      });
      ctx.provenance.addEdge({
        from: modelCallNodeId,
        to: `input:${ctx.userMessage.sequence}`,
        kind: 'caused-by',
      });
    }

    // Partial iteration output — `dispatch-tools` finishes it.
    const partial: Omit<AgentTurnIterationOutput, 'iterationAppended' | 'finishedTurn'> & {
      readonly step: number;
    } = {
      step: ctx.usage.steps,
      finishReason: callResult.finishReason,
      message: callResult.message,
      iterationUsage: {
        promptTokens: callResult.usage.promptTokens,
        completionTokens: callResult.usage.completionTokens,
        costUsd: callResult.costUsd,
      },
      provider: callResult.provider,
      nextMessages,
    };
    return partial;
  };
}

/** Longest cause text a failure message carries. */
const MAX_CAUSE_CHARS = 500;

/** A thrown value's message on one line, at most `MAX_CAUSE_CHARS` long. */
function describeCause(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return cause instanceof Error ? cause.name : 'no detail';
  return text.length > MAX_CAUSE_CHARS ? `${text.slice(0, MAX_CAUSE_CHARS - 1)}…` : text;
}
