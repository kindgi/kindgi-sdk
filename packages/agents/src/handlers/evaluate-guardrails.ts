// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage, UsageSink } from '@kindgi/capabilities';
import type {
  EvaluationOutcome,
  EvaluationResult,
  Guardrail,
  GuardrailCheckOutcome,
} from '@kindgi/guardrails';
import type { LoopNodeOutput, NodeContext, NodeHandler } from '@kindgi/handler';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { FlowId, RunId, TenantId, Timestamp } from '@kindgi/types';

import {
  type GuardrailEvaluationError,
  buildRunTrace,
  categorizeOutcomes,
  describeBlockingViolations,
  evaluateGate,
} from '../guardrails-gate.js';
import { emitTurnEvent } from '../streaming.js';
import type { ConversationMessage } from '../types.js';

import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { finalIteration } from './final-iteration.js';
import { isRetryGuardrail, judgedInLoop, turnRetryNotes } from './guardrail-retry.js';
import { replayTag } from './replay.js';
import { parseJsonAnswer } from './structured-output.js';

/**
 * Guardrail gate on the turn's final response, before it is stored.
 * Receives the agent loop's output. A failed guardrail whose action is
 * `halt` throws, so the run fails and the response never reaches the
 * conversation. A `retry` guardrail's failure is the loop's to act on:
 * in a turn with a `retry` guardrail, `budget-check` judges each finished
 * answer on the `halt` and `retry` guardrails and sends a failed one back
 * while attempts last, and this node judges the answer the loop let
 * finish on the other guardrails. A final answer the loop didn't judge in
 * this process (a turn resumed elsewhere) is judged here on every
 * guardrail, and a `retry` guardrail that fails it is out of attempts:
 * the turn fails, as for a `halt`, except on a dry run, where it's only
 * recorded. Failures with any other action are stashed on `ctx` for
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

    addModelOutputNode(ctx, final.provider, evaluatedAt);

    // The loop judged this very answer on the `halt` and `retry` guardrails
    // (`budget-check`, in a turn with a `retry` guardrail), so the rest are
    // judged here. Any other final output is judged on every guardrail.
    const inLoop = judgedByLoop(ctx, input, final) ? ctx.answerJudgedInLoop : undefined;
    const guardrails =
      inLoop !== undefined ? ctx.guardrails.filter((g) => !judgedInLoop(g)) : ctx.guardrails;
    const categorized = await judgeAnswer(ctx, kctx, final.message, guardrails, evaluatedAt);
    // A `retry` guardrail that fails here can't send the answer back, as the
    // loop is done: it's out of attempts, and the turn fails. A dry run never
    // asks the model again, so there it's only recorded.
    const outOfAttempts = kctx.dryRun ? [] : categorized.retry;
    // Recorded before the gate acts on them, so a blocked turn is counted too.
    await recordOutcomes(ctx, kctx, evaluatedAt, withBlocked(categorized.checks, outOfAttempts));
    await emitGateEvents(ctx, categorized);
    // The checks the loop couldn't run on this answer show here as this
    // node's own do, in provenance and in its output (the journal); the
    // ledger and the events have them already, from `budget-check`.
    const errors =
      inLoop !== undefined
        ? inGuardrailOrder(ctx.guardrails, [...inLoop.errors, ...categorized.errors])
        : categorized.errors;
    // The turn's notes, from the journaled messages, so a resumed turn reads
    // them too. None without a `retry` guardrail.
    const notes = ctx.guardrails.some(isRetryGuardrail)
      ? turnRetryNotes(ctx, final.nextMessages)
      : [];
    addCheckNodes(ctx, violationsOf(categorized), errors, notes, evaluatedAt);

    if (categorized.blocking.length > 0 || categorized.blockingErrors.length > 0) {
      return await failTurn(ctx, categorized.blocking, categorized.blockingErrors, errors);
    }
    if (outOfAttempts.length > 0) {
      return await failTurn(ctx, outOfAttempts, [], errors, notes.length + 1);
    }

    const nonBlocking = [...categorized.warnings, ...categorized.retry, ...categorized.other];
    ctx.nonBlockingViolations = nonBlocking;

    return {
      blocking: categorized.blocking.length,
      warnings: categorized.warnings.length,
      other: categorized.retry.length + categorized.other.length,
      // The journal records the step's output: a check that couldn't run shows there.
      errors: errors.map((e) => ({
        guardrailId: e.guardrailId,
        ...(e.action !== undefined && { action: e.action }),
        code: e.code,
        message: e.message,
      })),
    };
  };
}

/**
 * Whether the loop's final output is the answer `budget-check` judged
 * and let finish the turn (`ctx.answerJudgedInLoop`): the loop ended on
 * its exit condition, at that iteration, with that message. Anything
 * else (no such answer in this process, the loop out of iterations, an
 * output the flag doesn't name) is judged on every guardrail.
 */
function judgedByLoop(
  ctx: TurnContext,
  loopOutput: unknown,
  final: AgentTurnIterationOutput,
): boolean {
  const judged = ctx.answerJudgedInLoop;
  if (judged === undefined) return false;
  const output = loopOutput as LoopNodeOutput<AgentTurnIterationOutput>;
  return (
    output.stopReason === 'exit-condition' &&
    output.iterations - 1 === judged.iteration &&
    final.finishedTurn &&
    JSON.stringify(final.message) === judged.message
  );
}

type Categorized = ReturnType<typeof categorizeOutcomes>;

/** `errors` in the order of the turn's guardrails, as the gate lists a turn's. */
function inGuardrailOrder(
  guardrails: readonly Guardrail[],
  errors: readonly GuardrailEvaluationError[],
): readonly GuardrailEvaluationError[] {
  const at = new Map(guardrails.map((g, i) => [g.id as unknown as string, i]));
  const order = (e: GuardrailEvaluationError) => at.get(e.guardrailId) ?? guardrails.length;
  return [...errors].sort((a, b) => order(a) - order(b));
}

/**
 * The final answer's `model-output` node in provenance, `produced` by its
 * model call: what its guardrail checks link to (`addCheckNodes`).
 */
export function addModelOutputNode(
  ctx: TurnContext,
  provider: AgentTurnIterationOutput['provider'],
  at: Timestamp,
): void {
  const provenance = ctx.provenance;
  if (provenance === undefined) return;
  const output = `model-output:${ctx.usage.steps}`;
  provenance.addNode({
    id: output,
    kind: 'model-output',
    timestamp: at,
    modelVersion: `${provider.id}/${provider.model}`,
  });
  provenance.addEdge({ from: output, to: `model-call:${ctx.usage.steps}`, kind: 'produced' });
}

/**
 * The final answer's guardrail checks in provenance, each `influenced-by`
 * its `model-output` node: a node per failed check, one per check that
 * couldn't run (`evaluated: false`), and one per guardrail that sent an
 * earlier answer back (`notes`): its note was in what the model read.
 * Added, with the answer's node (`addModelOutputNode`), by the step that
 * judges the final answer: this node, or `budget-check` when it fails
 * the turn.
 */
export function addCheckNodes(
  ctx: TurnContext,
  violations: readonly EvaluationResult[],
  errors: readonly GuardrailEvaluationError[],
  notes: readonly (readonly string[])[],
  evaluatedAt: Timestamp,
): void {
  const provenance = ctx.provenance;
  if (provenance === undefined) return;
  const output = `model-output:${ctx.usage.steps}`;
  const add = (id: string, timestamp: Timestamp, attributes: Record<string, unknown>) => {
    provenance.addNode({ id, kind: 'guardrail-check', timestamp, attributes });
    provenance.addEdge({ from: id, to: output, kind: 'influenced-by' });
  };
  for (const v of violations) {
    add(`guardrail-check:${v.guardrailId}`, v.at, {
      guardrailId: v.guardrailId,
      action: v.action,
      severity: v.severity,
      passed: false,
      ...(v.result.reason !== undefined && { reason: v.result.reason }),
    });
  }
  for (const e of errors) {
    add(`guardrail-check:${e.guardrailId}`, evaluatedAt, {
      guardrailId: e.guardrailId,
      ...(e.action !== undefined && { action: e.action }),
      ...(e.severity !== undefined && { severity: e.severity }),
      evaluated: false,
      error: e.code,
      reason: e.message,
    });
  }
  notes.forEach((ids, i) => {
    for (const guardrailId of ids) {
      add(`guardrail-check:${guardrailId}:sent-back:${i + 1}`, evaluatedAt, {
        guardrailId,
        action: 'retry',
        passed: false,
        sentBack: i + 1,
      });
    }
  });
}

/** Every failed check, in the order the gate reports them. */
export function violationsOf(categorized: Categorized): readonly EvaluationResult[] {
  return [
    ...categorized.blocking,
    ...categorized.warnings,
    ...categorized.retry,
    ...categorized.other,
  ];
}

/**
 * Judges `answer` on `guardrails`: the turn's trace with it as the
 * response, as it would be stored, through the gate. Shared by this
 * node and the loop's `budget-check`, which judges each finished answer
 * on a turn's `halt` and `retry` guardrails.
 */
export async function judgeAnswer(
  ctx: TurnContext,
  kctx: NodeContext,
  answer: ModelMessage,
  guardrails: readonly Guardrail[],
  evaluatedAt: Timestamp,
): Promise<Categorized> {
  if (guardrails.length === 0) return categorizeOutcomes([], []);
  // The response as it would be stored; not persisted yet.
  const response: ConversationMessage = {
    sequence: -1,
    role: 'agent',
    content: answer.content ?? '',
    createdAt: evaluatedAt,
    actor: ctx.input.agent.id,
  };
  const usage = {
    steps: ctx.usage.steps,
    promptTokens: ctx.usage.promptTokens,
    completionTokens: ctx.usage.completionTokens,
    totalCostUsd: ctx.usage.totalCostUsd,
    durationMs: Date.now() - ctx.startedAt,
  };
  const structured =
    ctx.input.agent.output !== undefined && !kctx.dryRun
      ? parseJsonAnswer(answer.content)
      : undefined;
  const flowId = await flowOfTurn(ctx, kctx, guardrails);
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
    usage,
  });
  const outcomes = await evaluateGate(
    guardrails,
    trace,
    ctx.bindings,
    ctx.tenantPolicy,
    ctx.turnAbort.signal,
    judgeUsageSink(ctx, kctx),
  );
  throwIfJudgeCallsUnrecorded(outcomes);
  return categorizeOutcomes(outcomes, guardrails);
}

/**
 * The ledger's checks with each of `outOfAttempts` (`retry` guardrails
 * that ran out of attempts on this answer) `blocked`: it failed the
 * turn, as a `halt` does.
 */
export function withBlocked(
  checks: readonly GuardrailCheckOutcome[],
  outOfAttempts: readonly EvaluationResult[],
): readonly GuardrailCheckOutcome[] {
  if (outOfAttempts.length === 0) return checks;
  const ids = new Set(outOfAttempts.map((v) => v.guardrailId as unknown as string));
  return checks.map((c) =>
    c.outcome === 'violated' && ids.has(c.guardrailId) ? { ...c, outcome: 'blocked' } : c,
  );
}

/**
 * A `guardrail.violated` event for each failed check, and a
 * `guardrail.error` one for each check that couldn't run.
 */
export async function emitGateEvents(ctx: TurnContext, categorized: Categorized): Promise<void> {
  for (const v of violationsOf(categorized)) {
    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'guardrail.violated',
      action: v.action,
      severity: v.severity,
      guardrailId: v.guardrailId,
      ...(v.result.reason !== undefined && { reason: v.result.reason }),
    });
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
  }
}

/**
 * Fails the turn with `guardrail-violation`: a `halt` guardrail failed
 * (or couldn't check), or `retry` guardrails ran out of `attempts`.
 */
export async function failTurn(
  ctx: TurnContext,
  violations: readonly EvaluationResult[],
  blockingErrors: readonly GuardrailEvaluationError[],
  evaluationErrors: readonly GuardrailEvaluationError[],
  attempts?: number,
): Promise<never> {
  const message = describeBlockingViolations(violations, blockingErrors, attempts);
  await emitTurnEvent(ctx.bindings.onEvent, {
    kind: 'turn.failed',
    conversationId: ctx.input.conversationId,
    errorCode: 'guardrail-violation',
    message,
  });
  throwAgentTurnFailure({
    code: 'guardrail-violation',
    message,
    violations,
    evaluationErrors,
    ...(attempts !== undefined && { attempts }),
  });
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
async function flowOfTurn(
  ctx: TurnContext,
  kctx: NodeContext,
  guardrails: readonly Guardrail[],
): Promise<FlowId | undefined> {
  if (!guardrails.some(scopedToFlows)) return undefined;
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
export async function recordOutcomes(
  ctx: TurnContext,
  kctx: NodeContext,
  at: Timestamp,
  checks: readonly GuardrailCheckOutcome[],
  stepId: string = kctx.nodeId as unknown as string,
): Promise<void> {
  const sink = ctx.bindings.guardrailOutcomes;
  if (sink === undefined || checks.length === 0) return;
  if (ctx.input.replay !== undefined || kctx.dryRun) return;
  try {
    await sink.record({
      tenantId: ctx.input.tenantId,
      projectId: ctx.input.projectId,
      runId: kctx.runId,
      nodeId: stepId,
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
