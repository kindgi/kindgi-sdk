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
 *     `setup` journaled;
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
 * Not restored: provenance nodes recorded before the park. The resumed
 * turn's provenance covers what happens from the resume on.
 */

import type { LoopContext } from '@kindgi/handler';
import { type JournalEntry, bodyStepKey } from '@kindgi/runtime';

import type { ConversationMessage, RetrievedFact } from '../types.js';
import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import {
  loadTurnConversation,
  resolveTurnEnvironment,
  resolveTurnHitlPolicy,
} from './turn-environment.js';

interface StepRecord {
  readonly nodeId: string;
  readonly output: unknown;
  readonly inLoop: boolean;
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
  const setup = outputOf<{ readonly providerId: string; readonly providerModel: string }>(
    steps,
    'setup',
  );
  if (setup === undefined) return false;

  if (ctx.bindings.provenance?.newBuilder !== undefined) {
    ctx.provenance = ctx.bindings.provenance.newBuilder({ runId, tenantId: ctx.input.tenantId });
    ctx.provenanceBindings = ctx.bindings.provenance;
  }
  await loadTurnConversation(ctx);
  ctx.hitlPolicy = await resolveTurnHitlPolicy(ctx);
  await resolveTurnEnvironment(ctx, { providerId: setup.providerId, model: setup.providerModel });

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
  return true;
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
