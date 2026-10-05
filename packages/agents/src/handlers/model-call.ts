// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import {
  type ModelCallInput,
  type ModelMessage,
  type ModelProvider,
  type ModelUsageRecord,
  recordModelUsage,
} from '@kindgi/capabilities';
import { attemptsOf } from '@kindgi/capabilities/attempts';
import type { NodeContext, NodeHandler } from '@kindgi/handler';

import { emitTurnEvent } from '../streaming.js';

import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Loop-body node #1. Invoke the model with the current
 * `nextMessages` accumulator. Emits `model.call.started` +
 * `model.call.completed`, records provenance for the model-call node,
 * and accumulates usage on `ctx.usage`.
 *
 * Every call is recorded in the usage sink (`InvokeAgentBindings.usage`,
 * the runtime's cost ledger) before the step goes on, a call that threw
 * included. A sink that fails is tried again (a record is idempotent by
 * call id); one that still fails fails the step when the call succeeded,
 * so no answered call is left unrecorded. A call that failed keeps its
 * own failure, which says it couldn't be recorded too. The call's id goes into
 * the step's output and its provenance node, which keeps the call's
 * identity (provider, model) while its usage lives in the ledger. A dry
 * run spends nothing and records nothing.
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
    const step = ctx.usage.steps;
    const callId = randomUUID();

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

      const startedAt = Date.now();
      try {
        callResult = await ctx.provider.invoke(callInput);
      } catch (cause) {
        return await failCall(ctx, kctx, { callId, step, cause, startedAt });
      }
      await recordAnswer(ctx, kctx, callId, step, callResult);
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
        // The call's identity. Its usage is the cost ledger's, by `callId`.
        attributes: {
          step: ctx.usage.steps,
          callId,
          providerId: callResult.provider.id,
          model: callResult.provider.model,
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
      readonly callId: string;
    } = {
      step: ctx.usage.steps,
      callId,
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

/**
 * A call that answered: record it before the step goes on. A sink that
 * still fails after its retries fails the step: an answered call isn't
 * left unrecorded.
 */
async function recordAnswer(
  ctx: TurnContext,
  kctx: NodeContext,
  callId: string,
  step: number,
  answer: Awaited<ReturnType<ModelProvider['invoke']>>,
): Promise<void> {
  const { message: _answer, ...result } = answer;
  const unrecorded = await recordCall(ctx, kctx, {
    callId,
    step,
    status: 'ok',
    result,
    durationMs: answer.durationMs,
  });
  if (unrecorded !== undefined) {
    throwAgentTurnFailure({
      code: 'persistence-error',
      message: `The model call couldn't be recorded: ${describeCause(unrecorded)}`,
      cause: unrecorded,
    });
  }
}

/**
 * A call that threw: record it, then fail the step with the call's own
 * failure (aborted, or the provider's words). A record that failed too
 * is said after it.
 */
async function failCall(
  ctx: TurnContext,
  kctx: NodeContext,
  failed: {
    readonly callId: string;
    readonly step: number;
    readonly cause: unknown;
    readonly startedAt: number;
  },
): Promise<never> {
  const { cause } = failed;
  const attempts = attemptsOf(cause);
  const unrecorded = await recordCall(ctx, kctx, {
    callId: failed.callId,
    step: failed.step,
    status: 'failed',
    error: { message: describeCause(cause), ...(attempts !== undefined && { attempts }) },
    durationMs: Date.now() - failed.startedAt,
  });
  const andUnrecorded =
    unrecorded === undefined
      ? ''
      : ` (and the failed call couldn't be recorded: ${describeCause(unrecorded)})`;
  if (ctx.turnAbort.signal.aborted) {
    throwAgentTurnFailure({
      code: 'agent-turn-aborted',
      message: `Agent turn aborted: ${cause instanceof Error ? cause.message : String(cause)}${andUnrecorded}`,
      reason: ctx.abortReason ?? 'timeout',
    });
  }
  // The provider's own words (a 401's "invalid x-api-key", a 429) are
  // what the caller needs; they're in `cause` too, but callers show
  // `message`.
  throwAgentTurnFailure({
    code: 'model-invocation-failed',
    message: `Model call to ${ctx.provider?.metadata.id} (${ctx.model?.name}) failed: ${describeCause(cause)}${andUnrecorded}`,
    cause,
  });
}

/** What the call came to, for `recordCall`. */
type CallOutcome = Pick<
  ModelUsageRecord,
  'callId' | 'step' | 'status' | 'result' | 'error' | 'durationMs'
>;

/**
 * Record a model call in the usage sink, when the turn has one, trying
 * a failing sink again. Resolves with the sink's last failure when it
 * couldn't record; the caller decides what that means for the step.
 */
async function recordCall(
  ctx: TurnContext,
  kctx: NodeContext,
  call: CallOutcome,
): Promise<unknown | undefined> {
  const sink = ctx.bindings.usage;
  if (sink === undefined || ctx.provider === undefined || ctx.model === undefined) return;
  const { input } = ctx;
  const recorded = await recordModelUsage(sink, {
    ...call,
    tenantId: input.tenantId,
    projectId: input.projectId,
    runId: kctx.runId,
    agentId: input.agent.id as unknown as string,
    agentVersion: input.agent.version,
    conversationId: input.conversationId as unknown as string,
    nodeId: kctx.nodeId as unknown as string,
    providerId: ctx.provider.metadata.id,
    model: ctx.model.name,
    ...(ctx.provider.metadata.fallback === true && { fallback: true }),
    occurredAt: new Date().toISOString(),
  });
  return recorded.kind === 'err' ? (recorded.error ?? new Error('no detail')) : undefined;
}

/** Longest cause text a failure message carries. */
const MAX_CAUSE_CHARS = 500;

/** A thrown value's message on one line, at most `MAX_CAUSE_CHARS` long. */
function describeCause(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return cause instanceof Error ? cause.name : 'no detail';
  return text.length > MAX_CAUSE_CHARS ? `${text.slice(0, MAX_CAUSE_CHARS - 1)}…` : text;
}
