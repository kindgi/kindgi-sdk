// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelProvider, TenantPolicy } from '@kindgi/capabilities';
import { createProviderRegistry } from '@kindgi/capabilities';
import type { Guardrail } from '@kindgi/guardrails';
import { createCheckRegistry } from '@kindgi/guardrails';
import type { NodeContext } from '@kindgi/handler';
import type { GuardrailId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildEvaluateGuardrailsHandler } from '../src/handlers/evaluate-guardrails.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { ConversationId } from '../src/types.js';

const tenantId = 'acme' as TenantId;

/** A judge provider in `region` that records when it is called. */
function judge(id: string, region: string, calls: string[]): ModelProvider {
  return {
    metadata: {
      id,
      region,
      models: [
        {
          name: `${id}-model`,
          contextWindow: 8000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
        },
      ],
    },
    invoke: async () => {
      calls.push(id);
      return {
        message: { role: 'assistant', content: 'PASS\nFine.' },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        costUsd: 0,
        durationMs: 1,
        provider: { id, model: `${id}-model` },
      };
    },
  };
}

function turnContext(calls: string[], tenantPolicy: TenantPolicy | undefined): TurnContext {
  const agent = defineAgent({
    id: 'acme.helper',
    version: '1.0.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: ['acme.helpful'],
  });
  if (agent.kind === 'err') throw new Error('agent spec invalid');
  const checks = createCheckRegistry();
  checks.register({
    id: 'acme.judge',
    kind: 'llm-judge',
    evaluate: async () => ({ passed: true }),
  });
  const guardrail: Guardrail = {
    id: 'acme.helpful' as GuardrailId,
    kind: 'llm-judge',
    check: 'acme.judge',
    config: { rubric: 'Is the response helpful?' },
    action: { 'on-violation': 'log-only' },
    judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
  };
  // Without a policy the router would pick `judge-1` (first in order).
  const { registry: providerRegistry } = createProviderRegistry([
    { tenantId, provider: judge('judge-1', 'us-east-1', calls) },
    { tenantId, provider: judge('judge-2', 'eu-west-1', calls) },
  ]);
  return {
    input: {
      tenantId,
      projectId: 'p-1' as never,
      agent: agent.value,
      conversationId: 'c-1' as ConversationId,
      userMessage: 'hi',
    },
    bindings: { providerRegistry, checks } as unknown as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0 },
    abortReason: undefined,
    guardrails: [guardrail],
    ...(tenantPolicy !== undefined && { tenantPolicy }),
  };
}

const loopOutput = {
  finalOutput: {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'Here is the answer.' },
    iterationAppended: [],
    iterationUsage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
    provider: { id: 'judge-2', model: 'judge-2-model' },
    finishedTurn: true,
    nextMessages: [],
  },
  iterations: 1,
  stopReason: 'exit-condition',
};

describe('evaluate-guardrails — llm judges route under the turn tenant policy', () => {
  test('the judge uses a model the tenant policy allows', async () => {
    const calls: string[] = [];
    const ctx = turnContext(calls, { tenantId, regionAllow: ['eu-west-1'] });
    await buildEvaluateGuardrailsHandler(ctx)(loopOutput, {} as NodeContext);
    expect(calls).toEqual(['judge-2']);
  });

  test('without a tenant policy routing is unconstrained', async () => {
    const calls: string[] = [];
    const ctx = turnContext(calls, undefined);
    await buildEvaluateGuardrailsHandler(ctx)(loopOutput, {} as NodeContext);
    expect(calls).toEqual(['judge-1']);
  });
});

describe('evaluate-guardrails — checks stop when the turn does', () => {
  /** A judge that records the signal it was called with and waits for it to fire. */
  function hangingJudge(seen: (AbortSignal | undefined)[]): ModelProvider {
    const base = judge('judge-1', 'us-east-1', []);
    return {
      ...base,
      invoke: (input) => {
        seen.push(input.abortSignal);
        return new Promise((_resolve, reject) => {
          input.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    };
  }

  test("the judge's model call gets the turn's abort signal, and a stuck judge ends with the turn", async () => {
    const ctx = turnContext([], undefined);
    const seen: (AbortSignal | undefined)[] = [];
    const { registry } = createProviderRegistry([{ tenantId, provider: hangingJudge(seen) }]);
    const stuck = {
      ...ctx,
      bindings: { ...ctx.bindings, providerRegistry: registry },
    } as unknown as TurnContext;
    const evaluating = buildEvaluateGuardrailsHandler(stuck)(loopOutput, {} as NodeContext).catch(
      (cause: unknown) => cause,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([stuck.turnAbort.signal]);
    // The turn's wall clock fires: the judge stops waiting, and so does the gate.
    stuck.turnAbort.abort(new Error('wall-clock budget exhausted'));
    const settled = await Promise.race([
      evaluating.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still waiting'), 1000)),
    ]);
    expect(settled).toBe('settled');
  });

  test('a zero-llm check gets the signal in its bindings', async () => {
    const ctx = turnContext([], undefined);
    const received: (AbortSignal | undefined)[] = [];
    const checks = createCheckRegistry();
    checks.register({
      id: 'acme.records',
      kind: 'zero-llm',
      evaluate: async (_config, _trace, bindings) => {
        received.push(bindings.abortSignal);
        return { passed: true };
      },
    });
    const withCheck = {
      ...ctx,
      bindings: { ...ctx.bindings, checks },
      guardrails: [
        {
          id: 'acme.records' as GuardrailId,
          kind: 'zero-llm',
          check: 'acme.records',
          action: { 'on-violation': 'log-only' },
        } as Guardrail,
      ],
    } as unknown as TurnContext;
    await buildEvaluateGuardrailsHandler(withCheck)(loopOutput, {} as NodeContext);
    expect(received).toEqual([withCheck.turnAbort.signal]);
  });
});
