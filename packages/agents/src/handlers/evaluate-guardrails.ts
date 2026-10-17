// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { UsageSink } from '@kindgi/capabilities';
import type { EvaluationOutcome, Guardrail, GuardrailCheckOutcome } from '@kindgi/guardrails';
import type { NodeContext, NodeHandler } from '@kindgi/handler';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { FlowId, RunId, TenantId, Timestamp } from '@kindgi/types';

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
 * link to. When one of the turn's guardrails is scoped to flows, the
 * trace names the flow whose step started the turn (`flowOfTurn`), which
 * that guardrail applies by.
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
    const flowId = await flowOfTurn(ctx, kctx);
    const trace = buildRunTrace({
      runId: kctx.runId,
      tenantId: ctx.input.tenantId,
      projectId: ctx.input.projectId,
      ...(ctx.input.orgId !== undefined && { orgId: ctx.input.orgId }),
      conversationId: ctx.input.conversationId,
      turnNumber: (ctx.conversation?.turnCount ?? 0) + 1,
      agent: ctx.input.agent,
      ...(flowId !== undefined && { flowId }),
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
    // Recorded before the gate acts on them, so a blocked turn is counted too.
    await recordOutcomes(ctx, kctx, evaluatedAt, categorized.checks);

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

/** The most replays `parentOfRun` follows back to the run they replay. */
const MAX_REPLAY_HOPS = 10;

/**
 * The flow whose step started this turn, which a guardrail scoped to
 * flows (`scope.flows`) applies by: the flow of the turn's parent run.
 * Undefined for a turn outside any flow, and unread unless one of the
 * turn's guardrails is scoped to flows: no other guardrail needs it, so
 * a turn without one reads no run and never fails on one. A started
 * turn's input names the parent (`parent`); a resumed turn's doesn't, so
 * its own run's record does. A replay's run has no parent, so a replay
 * takes the flow of the run it replays (`replay.of`), as the original
 * turn did. A run that can't be read, or a replayed run that's gone,
 * fails the step, so a guardrail scoped to flows never passes over a
 * turn whose flow went unread.
 */
async function flowOfTurn(ctx: TurnContext, kctx: NodeContext): Promise<FlowId | undefined> {
  if (ctx.guardrails === undefined || !ctx.guardrails.some(scopedToFlows)) return undefined;
  const runs = ctx.bindings.runBinding;
  if (runs === undefined) {
    throw new Error('evaluate-guardrails: bindings.runBinding is required.');
  }
  const { tenantId } = ctx.input;
  const replayed = ctx.input.replay?.of;
  const parentRunId =
    ctx.input.parent?.runId ??
    (await parentOfRun(runs, tenantId, replayed ?? kctx.runId, replayed !== undefined));
  if (parentRunId === undefined) return undefined;
  return (await readRun(runs, tenantId, parentRunId, false)).flowId as FlowId;
}

/** Whether the guardrail applies by flow, as the engine's scope check reads `scope.flows`. */
function scopedToFlows(guardrail: Guardrail): boolean {
  return (guardrail.scope?.flows?.length ?? 0) > 0;
}

/**
 * The run's parent, or, for a replay's run, the parent of the run it
 * replays (`replayOf`), followed through a replay of a replay. Undefined
 * when the chain ends at a run outside any flow. `replayed` says the
 * turn replays `start`, so a run of the chain that's gone is a replayed
 * run that's gone. A chain that comes back to a run, or goes past
 * `MAX_REPLAY_HOPS` replays, fails the step as an unreadable run does.
 */
async function parentOfRun(
  runs: RunBinding,
  tenantId: TenantId,
  start: RunId,
  replayed: boolean,
): Promise<RunId | undefined> {
  const seen = new Set<RunId>();
  let runId = start;
  for (let hops = 0; ; hops++) {
    seen.add(runId);
    const run = await readRun(runs, tenantId, runId, replayed);
    if (run.parentRunId !== undefined && run.parentRunId !== null) return run.parentRunId;
    if (run.replayOf === undefined || run.replayOf === null) return undefined;
    if (seen.has(run.replayOf)) {
      throwAgentTurnFailure({
        code: 'persistence-error',
        message: `Run ${run.replayOf} comes back in run ${start}'s replay chain, so the turn's flow is unknown`,
        cause: null,
      });
    }
    if (hops === MAX_REPLAY_HOPS) {
      throwAgentTurnFailure({
        code: 'persistence-error',
        message: `Run ${start}'s replay chain goes on past ${MAX_REPLAY_HOPS} replays, so the turn's flow is unknown`,
        cause: null,
      });
    }
    runId = run.replayOf;
  }
}

/** Reads the run; `replayed` says the turn replays it, for the message when it's gone. */
async function readRun(
  runs: RunBinding,
  tenantId: TenantId,
  runId: RunId,
  replayed: boolean,
): Promise<KernelRunRecord> {
  let run: KernelRunRecord | null;
  try {
    run = await runs.getRun(tenantId, runId);
  } catch (cause) {
    throwAgentTurnFailure({
      code: 'persistence-error',
      message: `Run ${runId} couldn't be read to find the turn's flow: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    });
  }
  if (run === null) {
    throwAgentTurnFailure({
      code: 'persistence-error',
      message: replayed
        ? `Run ${runId}, which this turn replays, is gone, so the turn's flow is unknown`
        : `Run ${runId} wasn't found, so the turn's flow is unknown`,
      cause: null,
    });
  }
  return run;
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
 * Records what each guardrail's check came to in the outcome ledger
 * (`bindings.guardrailOutcomes`). A replay or a dry run records nothing:
 * its outcomes aren't production's. Outcomes that couldn't be recorded
 * fail the step, as an unrecorded model call does, so the counts never
 * silently miss a turn.
 */
async function recordOutcomes(
  ctx: TurnContext,
  kctx: NodeContext,
  at: Timestamp,
  checks: readonly GuardrailCheckOutcome[],
): Promise<void> {
  const sink = ctx.bindings.guardrailOutcomes;
  if (sink === undefined || checks.length === 0) return;
  if (ctx.input.replay !== undefined || kctx.dryRun) return;
  try {
    await sink.record({
      tenantId: ctx.input.tenantId,
      projectId: ctx.input.projectId,
      runId: kctx.runId,
      nodeId: kctx.nodeId as unknown as string,
      agentId: ctx.input.agent.id,
      agentVersion: ctx.input.agent.version,
      at,
      checks,
    });
  } catch (cause) {
    throwAgentTurnFailure({
      code: 'persistence-error',
      message: `The guardrail outcomes couldn't be recorded: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    });
  }
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
