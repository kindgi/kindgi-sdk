// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeHandler } from '@kindgi/handler';

import { emitTurnEvent } from '../streaming.js';
import type { AgentTurnResult, AgentTurnUsage, AgentTurnWarning } from './result-shape.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { replayReport } from './replay.js';
import { parseJsonAnswer } from './structured-output.js';

/** The final answer as JSON — `budget-check` already validated it against the schema. */
function structuredAnswer(content: unknown): unknown {
  const parsed = parseJsonAnswer(content);
  return parsed.kind === 'ok' ? parsed.value : null;
}

/** The turn's warnings: a fallback provider answered, then the providers' own. */
function turnWarnings(
  ctx: TurnContext,
  providerId: string,
): { readonly warnings?: readonly AgentTurnWarning[] } {
  const warnings: AgentTurnWarning[] = [];
  if (ctx.provider?.metadata.fallback === true) {
    warnings.push({
      code: 'fallback-provider',
      message: `Answered by "${providerId}", a fallback provider: no other registered provider satisfies agent "${ctx.input.agent.id}".`,
    });
  }
  for (const [code, message] of ctx.modelWarnings ?? []) warnings.push({ code, message });
  return warnings.length > 0 ? { warnings } : {};
}

/**
 * The terminal node — builds the caller-facing `AgentTurnResult` from
 * accumulated `TurnContext` state, emits `turn.completed`, and returns
 * the fully-shaped result as the flow's output. `projectRunResult`
 * unwraps this on the way out.
 */
export function buildComposeResultHandler(ctx: TurnContext): NodeHandler {
  return async (_input, kctx) => {
    if (ctx.finalMessage === undefined || ctx.conversation === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'compose-result invoked before final message + conversation ready',
        cause: null,
      });
    }
    const durationMs = Date.now() - ctx.startedAt;
    const usage: AgentTurnUsage = {
      steps: ctx.usage.steps,
      promptTokens: ctx.usage.promptTokens,
      completionTokens: ctx.usage.completionTokens,
      totalCostUsd: ctx.usage.totalCostUsd,
      durationMs,
    };

    const provider = ctx.lastProvider ?? {
      id: ctx.provider?.metadata.id ?? 'unknown',
      model: ctx.model?.name ?? 'unknown',
    };

    const replay = replayReport(ctx);
    const result: AgentTurnResult = {
      runId: kctx.runId,
      conversationId: ctx.input.conversationId,
      // Dry-run must not advance the conversation's turn counter (no
      // persistence happened). Real runs report the next turn number.
      turnNumber: kctx.dryRun ? ctx.conversation.turnCount : ctx.conversation.turnCount + 1,
      appended: ctx.appended,
      response: ctx.finalMessage,
      retrieved: ctx.retrieved ?? [],
      violations: ctx.nonBlockingViolations ?? [],
      usage,
      provider,
      ...turnWarnings(ctx, provider.id),
      ...(ctx.input.agent.output !== undefined && {
        output: kctx.dryRun ? null : structuredAnswer(ctx.finalMessage.content),
      }),
      ...(ctx.persistedProvenance !== undefined && { provenance: ctx.persistedProvenance }),
      ...(kctx.dryRun && { dryRun: true }),
      ...(replay !== undefined && { replay }),
    };

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'turn.completed',
      conversationId: ctx.input.conversationId,
      turnNumber: ctx.conversation.turnCount + 1,
      response: ctx.finalMessage,
      retrieved: ctx.retrieved ?? [],
      durationMs,
      totalCostUsd: ctx.usage.totalCostUsd,
    });

    // Wrapped explicitly: the runtime reads a returned object with an
    // `output` key as `{ output, stateDelta }`, and a typed turn's
    // result has one.
    return { output: result };
  };
}
