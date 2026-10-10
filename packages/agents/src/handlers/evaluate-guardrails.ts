// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { UsageSink } from '@kindgi/capabilities';
import type { EvaluationOutcome } from '@kindgi/guardrails';
import type { NodeContext, NodeHandler } from '@kindgi/handler';
import type { Timestamp } from '@kindgi/types';

import {
  buildRunTrace,
  categorizeOutcomes,
  describeBlockingViolations,
  evaluateGate,
} from '../guardrails-gate.js';
import { emitTurnEvent } from '../streaming.js';
import type { ConversationMessage } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { finalIteration } from './final-iteration.js';
import { replayTag } from './replay.js';
import { parseJsonAnswer } from './structured-output.js';

/**
 * Guardrail gate on the turn's final response, before it is stored.
 * Receives the agent loop's output. A failed guardrail whose action is
 * `halt` throws, so the run fails and the response never reaches the
 * conversation; failures with any other action are stashed on `ctx` for
 * `compose-result` to surface in `AgentTurnResult.violations`. Every
 * failure emits a `guardrail.violated` event. A guardrail whose check
 * couldn't run (no such check, a bad configuration) emits
 * `guardrail.error` and gets a provenance node of its own; a `halt`
 * guardrail's error fails the turn too (it fails closed, as a
 * `guardrail-violation` whose `evaluationErrors` say why), and the step's
 * output lists every error, so the journal shows it. Also records the
 * response's `model-output` provenance node, which the guardrail checks
 * link to.
 */
export function buildEvaluateGuardrailsHandler(ctx: TurnContext): NodeHandler {
  return async (input: unknown, kctx) => {
    if (ctx.guardrails === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'evaluate-guardrails invoked before setup completed',
        cause: null,
      });
    }
    const final = finalIteration(input, 'evaluate-guardrails');
    const evaluatedAt = new Date().toISOString() as Timestamp;
    // The response as it would be stored; not persisted yet.
    const response: ConversationMessage = {
      sequence: -1,
      role: 'agent',
      content: final.message.content ?? '',
      createdAt: evaluatedAt,
      actor: ctx.input.agent.id,
    };

    if (ctx.provenance !== undefined) {
      ctx.provenance.addNode({
        id: `model-output:${ctx.usage.steps}`,
        kind: 'model-output',
        timestamp: evaluatedAt,
        modelVersion: `${final.provider.id}/${final.provider.model}`,
      });
      ctx.provenance.addEdge({
        from: `model-output:${ctx.usage.steps}`,
        to: `model-call:${ctx.usage.steps}`,
        kind: 'produced',
      });
    }

    const finalUsage = {
      steps: ctx.usage.steps,
      promptTokens: ctx.usage.promptTokens,
      completionTokens: ctx.usage.completionTokens,
      totalCostUsd: ctx.usage.totalCostUsd,
      durationMs: Date.now() - ctx.startedAt,
    };
    const structured =
      ctx.input.agent.output !== undefined && !kctx.dryRun
        ? parseJsonAnswer(final.message.content)
        : undefined;
    const trace = buildRunTrace({
      runId: kctx.runId,
      tenantId: ctx.input.tenantId,
      projectId: ctx.input.projectId,
      ...(ctx.input.orgId !== undefined && { orgId: ctx.input.orgId }),
      conversationId: ctx.input.conversationId,
      turnNumber: (ctx.conversation?.turnCount ?? 0) + 1,
      agent: ctx.input.agent,
      userMessage: ctx.input.userMessage,
      ...(ctx.input.input !== undefined && { stepInput: ctx.input.input }),
      ...(structured?.kind === 'ok' && { structuredOutput: structured.value }),
      appended: ctx.appended,
      finalResponse: response,
      usage: finalUsage,
    });
    const outcomes = await evaluateGate(
      ctx.guardrails,
      trace,
      ctx.bindings,
      ctx.tenantPolicy,
      ctx.turnAbort.signal,
      judgeUsageSink(ctx, kctx),
    );
    throwIfJudgeCallsUnrecorded(outcomes);
    const categorized = categorizeOutcomes(outcomes, ctx.guardrails);

    const allViolations = [...categorized.blocking, ...categorized.warnings, ...categorized.other];
    for (const v of allViolations) {
      await emitTurnEvent(ctx.bindings.onEvent, {
        kind: 'guardrail.violated',
        action: v.action,
        severity: v.severity,
        guardrailId: v.guardrailId,
        ...(v.result.reason !== undefined && { reason: v.result.reason }),
      });
      if (ctx.provenance !== undefined) {
        ctx.provenance.addNode({
          id: `guardrail-check:${v.guardrailId}`,
          kind: 'guardrail-check',
          timestamp: v.at,
          attributes: {
            guardrailId: v.guardrailId,
            action: v.action,
            severity: v.severity,
            passed: false,
            ...(v.result.reason !== undefined && { reason: v.result.reason }),
          },
        });
        ctx.provenance.addEdge({
          from: `guardrail-check:${v.guardrailId}`,
          to: `model-output:${ctx.usage.steps}`,
          kind: 'influenced-by',
        });
      }
    }

    for (const e of categorized.errors) {
      await emitTurnEvent(ctx.bindings.onEvent, {
        kind: 'guardrail.error',
        guardrailId: e.guardrailId,
        ...(e.action !== undefined && { action: e.action }),
        ...(e.severity !== undefined && { severity: e.severity }),
        code: e.code,
        message: e.message,
      });
      if (ctx.provenance !== undefined) {
        ctx.provenance.addNode({
          id: `guardrail-check:${e.guardrailId}`,
          kind: 'guardrail-check',
          timestamp: evaluatedAt,
          attributes: {
            guardrailId: e.guardrailId,
            ...(e.action !== undefined && { action: e.action }),
            ...(e.severity !== undefined && { severity: e.severity }),
            evaluated: false,
            error: e.code,
            reason: e.message,
          },
        });
        ctx.provenance.addEdge({
          from: `guardrail-check:${e.guardrailId}`,
          to: `model-output:${ctx.usage.steps}`,
          kind: 'influenced-by',
        });
      }
    }

    if (categorized.blocking.length > 0 || categorized.blockingErrors.length > 0) {
      const message = describeBlockingViolations(categorized.blocking, categorized.blockingErrors);
      await emitTurnEvent(ctx.bindings.onEvent, {
        kind: 'turn.failed',
        conversationId: ctx.input.conversationId,
        errorCode: 'guardrail-violation',
        message,
      });
      throwAgentTurnFailure({
        code: 'guardrail-violation',
        message,
        violations: categorized.blocking,
        evaluationErrors: categorized.errors,
      });
    }

    ctx.nonBlockingViolations = [...categorized.warnings, ...categorized.other];

    return {
      blocking: categorized.blocking.length,
      warnings: categorized.warnings.length,
      other: categorized.other.length,
      // The journal records the step's output: a check that couldn't run shows there.
      errors: categorized.errors.map((e) => ({
        guardrailId: e.guardrailId,
        ...(e.action !== undefined && { action: e.action }),
        code: e.code,
        message: e.message,
      })),
    };
  };
}

/**
 * The turn's usage sink for its llm-judge calls, adding what only the
 * turn knows: the step that made them and the agent's version.
 */
function judgeUsageSink(ctx: TurnContext, kctx: NodeContext): UsageSink | undefined {
  const sink = ctx.bindings.usage;
  if (sink === undefined) return undefined;
  return {
    record: (call) =>
      sink.record({
        nodeId: kctx.nodeId as unknown as string,
        agentVersion: ctx.input.agent.version,
        ...(ctx.input.replay !== undefined && { replay: replayTag(ctx.input.replay) }),
        ...call,
      }),
  };
}

/**
 * A judge call that answered but couldn't be recorded fails the step, as
 * the turn's own model calls do: no answered call is left unrecorded.
 */
function throwIfJudgeCallsUnrecorded(outcomes: readonly EvaluationOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.kind === 'err' && outcome.error.code === 'judge-usage-unrecorded') {
      throwAgentTurnFailure({
        code: 'persistence-error',
        message: outcome.error.message,
        cause: outcome.error,
      });
    }
  }
}
