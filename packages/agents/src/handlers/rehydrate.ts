// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Rebuild a resumed turn's in-memory context. The turn's handlers keep
 * what they resolve and accumulate on the `TurnContext`, and the kernel
 * doesn't re-run a step that completed before the park — so a turn
 * parked after `setup` (on a tool-call approval) would resume with none
 * of it. From the durable record:
 *
 *   - the environment — conversation, approval rules, guardrails, tools,
 *     policies — is resolved again, routed to the provider and model
 *     `setup` journaled, with the tool versions it journaled (a range
 *     isn't resolved again: a version published meanwhile doesn't run
 *     mid-turn);
 *   - the messages the turn stored come back from the conversation, from
 *     the turn's user message (`persist-user-message` journals its
 *     sequence);
 *   - the retrieved facts come from `run-retrievals`' journaled output;
 *   - usage is summed from the journaled model calls, so the step and
 *     cost budgets count the whole turn.
 *
 * The loop's steps that completed aren't run again either: the runtime
 * hands each its journaled result (`DerivedRunState.completedBodySteps`
 * in `@kindgi/runtime`). The step the turn parked in
 * (`dispatch-tools`, on the approval) runs again, and reuses the messages
 * it already stored (`TurnContext.storedBeforePark`).
 *
 * A turn parked inside `setup` (the session gate) re-runs `setup`, and
 * nothing here applies.
 *
 *   - the provenance nodes of the steps that ran before the park are
 *     added again from what they left (`turn-provenance.ts`), so a
 *     resumed turn's DAG is whole: its user message, its retrievals, each
 *     model call, and the tool calls of each completed step. The step the
 *     turn parked in adds its own when it runs again;
 *   - the tool-call approvals decided so far come from the journal (the
 *     waitpoint each gate recorded, when the call parked, the decision
 *     and when it came), so each call's provenance shows the approval it
 *     waited on and who decided it.
 */

import type { LoopContext } from '@kindgi/handler';
import { type JournalEntry, type ValueRecordedPayload, bodyStepKey } from '@kindgi/runtime';
import type { Timestamp } from '@kindgi/types';

import type { ConversationMessage, RetrievedFact } from '../types.js';
import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { readGateDecision } from './gate-decision.js';
import { TOOL_GATE_RECORD_PREFIX } from './tool-hitl.js';
import {
  loadTurnConversation,
  resolveTurnEnvironment,
  resolveTurnHitlPolicy,
} from './turn-environment.js';
import {
  addInputNode,
  addModelCallNode,
  addRetrievalNodes,
  addStepToolNodes,
} from './turn-provenance.js';
import type { ToolApproval } from './turn-provenance.js';
import type { PinnedBlockVersions } from './resolve-blocks.js';

interface StepRecord {
  readonly nodeId: string;
  readonly output: unknown;
  readonly inLoop: boolean;
  /** When the step completed. */
  readonly at: Timestamp;
}

/** Each step's last completion — a step at one loop iteration counts once. */
function completedSteps(journal: readonly JournalEntry[]): readonly StepRecord[] {
  const byStep = new Map<string, StepRecord>();
  for (const e of journal) {
    if (e.kind !== 'step.completed' || e.nodeId === undefined) continue;
    const payload = (e.payload ?? {}) as {
      readonly output?: unknown;
      readonly loopContext?: LoopContext;
    };
    const key =
      payload.loopContext === undefined
        ? (e.nodeId as unknown as string)
        : bodyStepKey(e.nodeId, payload.loopContext);
    byStep.delete(key);
    byStep.set(key, {
      nodeId: e.nodeId as unknown as string,
      output: payload.output,
      inLoop: payload.loopContext !== undefined,
      at: e.timestamp,
    });
  }
  return [...byStep.values()];
}

/** The output of an outer step that completed, if it did. */
function outputOf<T>(steps: readonly StepRecord[], nodeId: string): T | undefined {
  return steps.find((s) => s.nodeId === nodeId && !s.inLoop)?.output as T | undefined;
}

/**
 * Restore `ctx` for a turn being resumed. Returns `false` when `setup`
 * hasn't completed (it will run, and resolve everything itself).
 */
export async function rehydrateTurnContext(
  ctx: TurnContext,
  runId: string,
  journal: readonly JournalEntry[],
): Promise<boolean> {
  const steps = completedSteps(journal);
  const setup = outputOf<{
    readonly providerId: string;
    readonly providerModel: string;
    readonly toolVersions?: Readonly<Record<string, string>>;
    readonly blockVersions?: PinnedBlockVersions;
  }>(steps, 'setup');
  if (setup === undefined) return false;

  if (ctx.bindings.provenance?.newBuilder !== undefined) {
    ctx.provenance = ctx.bindings.provenance.newBuilder({ runId, tenantId: ctx.input.tenantId });
    ctx.provenanceBindings = ctx.bindings.provenance;
  }
  await loadTurnConversation(ctx);
  ctx.hitlPolicy = await resolveTurnHitlPolicy(ctx);
  // The route and the tool versions `setup` resolved: a resumed turn
  // runs those, never a range resolved again (a journal from before
  // `toolVersions` was recorded resolves the ranges, as it did).
  await resolveTurnEnvironment(
    ctx,
    { providerId: setup.providerId, model: setup.providerModel },
    setup.toolVersions,
    setup.blockVersions,
  );

  const userMessage = outputOf<{ readonly sequence: number }>(steps, 'persist-user-message');
  if (userMessage !== undefined) {
    await restoreAppended(ctx, userMessage.sequence);
    ctx.storedBeforePark = storedBeforePark(ctx, steps);
  }

  const retrievals = outputOf<{ readonly retrieved?: readonly RetrievedFact[] }>(
    steps,
    'run-retrievals',
  );
  if (retrievals?.retrieved !== undefined) ctx.retrieved = retrievals.retrieved;

  for (const s of steps.filter((s) => s.nodeId === 'model-call' && s.inLoop)) {
    const out = s.output as {
      readonly step?: number;
      readonly iterationUsage?: {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly costUsd?: number;
      };
      readonly provider?: { readonly id: string; readonly model: string };
    };
    ctx.usage.steps = Math.max(ctx.usage.steps, out.step ?? 0);
    ctx.usage.promptTokens += out.iterationUsage?.promptTokens ?? 0;
    ctx.usage.completionTokens += out.iterationUsage?.completionTokens ?? 0;
    ctx.usage.totalCostUsd += out.iterationUsage?.costUsd ?? 0;
    if (out.provider !== undefined) ctx.lastProvider = out.provider;
  }
  ctx.toolApprovals = toolApprovalsOf(journal);
  rebuildProvenance(ctx, steps, retrievals?.retrieved);
  return true;
}

/**
 * The tool-call approvals the journal shows decided, by invocation id: the
 * waitpoint each call's gate recorded (`dispatch-tools`), when the call
 * parked on it (`wait.suspended`, the first), and the decision that
 * resolved it (`wait.resumed`).
 */
function toolApprovalsOf(journal: readonly JournalEntry[]): ReadonlyMap<string, ToolApproval> {
  const callOf = new Map<string, string>();
  const parkedAt = new Map<string, Timestamp>();
  const resumed = new Map<string, { readonly at: Timestamp; readonly value: unknown }>();
  for (const e of journal) {
    const gate = toolGateOf(e);
    if (gate !== undefined) callOf.set(gate.waitTokenId, gate.invocationId);
    const p = (e.payload ?? {}) as { readonly tokenId?: unknown; readonly value?: unknown };
    if (typeof p.tokenId !== 'string') continue;
    if (e.kind === 'wait.suspended' && !parkedAt.has(p.tokenId)) {
      parkedAt.set(p.tokenId, e.timestamp);
    }
    if (e.kind === 'wait.resumed') resumed.set(p.tokenId, { at: e.timestamp, value: p.value });
  }
  const approvals = new Map<string, ToolApproval>();
  for (const [waitTokenId, decided] of resumed) {
    const invocationId = callOf.get(waitTokenId);
    if (invocationId === undefined) continue;
    approvals.set(invocationId, {
      waitTokenId,
      parkedAt: parkedAt.get(waitTokenId) ?? decided.at,
      decidedAt: decided.at,
      decision: readGateDecision(decided.value),
    });
  }
  return approvals;
}

/** The waitpoint a tool call's gate recorded (`dispatch-tools`), if `e` is that record. */
function toolGateOf(
  e: JournalEntry,
): { readonly waitTokenId: string; readonly invocationId: string } | undefined {
  if (e.kind !== 'value.recorded') return undefined;
  const p = (e.payload ?? {}) as Partial<ValueRecordedPayload>;
  if (typeof p.key !== 'string' || !p.key.startsWith(TOOL_GATE_RECORD_PREFIX)) return undefined;
  const waitTokenId = (p.value as { readonly waitTokenId?: unknown } | undefined)?.waitTokenId;
  return typeof waitTokenId === 'string'
    ? { waitTokenId, invocationId: p.key.slice(TOOL_GATE_RECORD_PREFIX.length) }
    : undefined;
}

/** A completed model-call step's output, as far as provenance reads it. */
interface ModelCallStepOutput {
  readonly step?: number;
  readonly callId?: string;
  readonly finishReason?: string;
  readonly provider?: { readonly id: string; readonly model: string };
}

/**
 * The provenance of the steps that ran before the park, in the order
 * they ran: the user message, the retrievals, then each model call with
 * the tool calls its completed step stored.
 */
function rebuildProvenance(
  ctx: TurnContext,
  steps: readonly StepRecord[],
  retrieved: readonly RetrievedFact[] | undefined,
): void {
  const input = ctx.userMessage;
  if (ctx.provenance === undefined || input === undefined) return;
  addInputNode(ctx.provenance, input);
  if (retrieved !== undefined) addRetrievalNodes(ctx.provenance, retrieved, input);

  const storedByStep = new Map<number, readonly ConversationMessage[]>();
  for (const s of steps.filter((s) => s.nodeId === 'dispatch-tools' && s.inLoop)) {
    const out = s.output as {
      readonly step?: number;
      readonly iterationAppended?: readonly ConversationMessage[];
    };
    if (out.step !== undefined) storedByStep.set(out.step, out.iterationAppended ?? []);
  }
  const calls = steps
    .filter((s) => s.nodeId === 'model-call' && s.inLoop)
    .map((s) => ({ at: s.at, out: s.output as ModelCallStepOutput }))
    .sort((a, b) => (a.out.step ?? 0) - (b.out.step ?? 0));
  for (const { at, out } of calls) {
    const { step, callId, provider, finishReason } = out;
    if (step === undefined || callId === undefined || provider === undefined) continue;
    addModelCallNode(
      ctx.provenance,
      { step, callId, provider, finishReason: finishReason ?? 'stop', at },
      input.sequence,
      [...(ctx.toolResultIds ?? [])],
    );
    addStepToolNodes(ctx, step, storedByStep.get(step) ?? []);
  }
}

/**
 * The messages no completed step accounts for: those the step the turn
 * parked in stored before it parked.
 */
function storedBeforePark(ctx: TurnContext, steps: readonly StepRecord[]): ConversationMessage[] {
  const accounted = new Set<number>();
  if (ctx.userMessage !== undefined) accounted.add(ctx.userMessage.sequence);
  for (const s of steps.filter((s) => s.nodeId === 'dispatch-tools' && s.inLoop)) {
    const out = s.output as { readonly iterationAppended?: readonly ConversationMessage[] };
    for (const m of out.iterationAppended ?? []) accounted.add(m.sequence);
  }
  return ctx.appended.filter((m) => !accounted.has(m.sequence));
}

/** The messages the turn stored before the park, from its user message on. */
async function restoreAppended(ctx: TurnContext, fromSequence: number): Promise<void> {
  const read = await ctx.bindings.conversationBinding.readMessages({
    tenantId: ctx.input.tenantId,
    conversationId: ctx.input.conversationId,
    sinceSequence: fromSequence - 1,
  });
  if (read.kind === 'err') throwAgentTurnFailure(read.error);
  const turnMessages: ConversationMessage[] = read.value.filter((m) => m.sequence >= fromSequence);
  ctx.appended.push(...turnMessages);
  const user = turnMessages.find((m) => m.sequence === fromSequence && m.role === 'user');
  if (user !== undefined) ctx.userMessage = user;
}
