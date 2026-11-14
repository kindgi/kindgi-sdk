// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a guardrail judge's model call warns about (`CheckResult.warnings`)
 * joins the turn's own warnings, once per code, naming the guardrail:
 * at the final answer, and at a point inside the loop, where a step run
 * again (resumed after a wait) reads its judgments back and still says them.
 */

import { describe, expect, test } from 'vitest';

import type { ModelCallWarning, ModelProvider } from '@kindgi/capabilities';
import { createProviderRegistry } from '@kindgi/capabilities';
import type { Guardrail, GuardrailPoint } from '@kindgi/guardrails';
import { createCheckRegistry } from '@kindgi/guardrails';
import type { NodeContext } from '@kindgi/handler';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { GuardrailId, NodeId, RunId, TenantId, ToolId } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { buildEvaluateGuardrailsHandler } from '../src/handlers/evaluate-guardrails.js';
import { guardrailPointFaults } from '../src/handlers/guardrail-points.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const tenantId = 'acme' as TenantId;
const runId = '00000000-0000-0000-0000-0000000000ef' as RunId;
const LOOKUP = 'acme.woo.lookup';

const SAMPLING: ModelCallWarning = {
  code: 'sampling-unsupported',
  message:
    "acme-large doesn't take a temperature, so the call went without one (it asked for 0.2).",
};

/** A judge on `acme-large` that passes, with `warnings`, its calls counted. */
function judge(calls: string[], warnings?: readonly ModelCallWarning[]): ModelProvider {
  return {
    metadata: {
      id: 'acme-llm',
      region: 'test',
      models: [
        {
          name: 'acme-large',
          contextWindow: 8000,
          features: ['tool-use'],
          sampling: false,
          cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
        },
      ],
    },
    invoke: async () => {
      calls.push('judge');
      return {
        message: { role: 'assistant', content: 'PASS\nFine.' },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        costUsd: 0,
        durationMs: 1,
        provider: { id: 'acme-llm', model: 'acme-large' },
        ...(warnings !== undefined && { warnings }),
      };
    },
  };
}

/** An llm-judge guardrail `id` at `at` (the final answer when absent). */
function judged(id: string, at?: GuardrailPoint): Guardrail {
  return {
    id: id as GuardrailId,
    kind: 'llm-judge',
    check: 'acme.judge',
    config: { rubric: 'Is it on the order?', temperature: 0.2 },
    action: { 'on-violation': 'log-only' },
    judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
    ...(at !== undefined && { at }),
  } as Guardrail;
}

function checks() {
  const registry = createCheckRegistry();
  registry.register({
    id: 'acme.judge',
    kind: 'llm-judge',
    points: ['final-answer', 'before-tool'],
    evaluate: async () => ({ passed: true }),
  });
  return registry;
}

function lookupTool(): AnyTool {
  const defined = defineTool<Record<string, unknown>, Record<string, unknown>>({
    id: LOOKUP as ToolId,
    description: 'Looks an order up.',
    version: '1.0.0',
    input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    output: { type: 'object', additionalProperties: true },
    effects: [],
    mutating: false,
    handler: async () => ({ order: 'A-1042' }),
  } as never);
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

/** A turn of `acme.helper` with `guardrails`, judged by `provider`. */
function turn(guardrails: readonly Guardrail[], provider: ModelProvider): TurnContext {
  const agent = {
    id: 'acme.helper',
    version: '1.0.0',
    guardrails: guardrails.map((g) => g.id),
  } as unknown as Agent;
  const registry = checks();
  const { registry: providerRegistry } = createProviderRegistry([{ tenantId, provider }]);
  let sequence = 100;
  const tool = lookupTool();
  return {
    input: {
      tenantId,
      projectId: 'p-1',
      conversationId: 'c-1',
      agent,
      userMessage: 'Where is order A-1042?',
    },
    bindings: {
      checks: registry,
      providerRegistry,
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { id: `msg-${++sequence}`, sequence, createdAt: '2026-11-06T08:00:00Z', ...m },
        }),
      },
      guardrailOutcomes: { record: async () => undefined },
      hitl: { enqueue: async () => undefined },
    } as unknown as InvokeAgentBindings,
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    provenance: { addNode: () => undefined, addEdge: () => undefined },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0 },
    initialMessageCount: 0,
    guardrails,
    guardrailPointFaults: guardrailPointFaults(guardrails, registry),
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
  } as unknown as TurnContext;
}

const finalAnswer = {
  finalOutput: {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'It shipped on Monday.' },
    iterationAppended: [],
    iterationUsage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
    provider: { id: 'acme-llm', model: 'acme-large' },
    finishedTurn: true,
    nextMessages: [],
  },
  iterations: 1,
  stopReason: 'exit-condition',
};

const finalNode = {
  runId,
  nodeId: 'evaluate-guardrails' as NodeId,
} as NodeContext;

/** One `dispatch-tools` step whose reply asks for a lookup, with the step's `records`. */
async function lookupStep(ctx: TurnContext, records: Map<string, unknown>): Promise<void> {
  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: LOOKUP, arguments: { q: 'A-1042' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
    },
    testNodeContext(
      {
        runId,
        nodeId: 'dispatch-tools' as NodeId,
        state: { $loop: { iteration: 0 } },
      } as Partial<NodeContext> & { readonly runId: RunId },
      records,
    ),
  );
}

const warnings = (ctx: TurnContext) => [...(ctx.modelWarnings ?? new Map()).entries()];

describe("a judge's warnings at the final answer", () => {
  test("join the turn's, naming the guardrail", async () => {
    const ctx = turn([judged('acme.on-topic')], judge([], [SAMPLING]));
    await buildEvaluateGuardrailsHandler(ctx)(finalAnswer, finalNode);
    expect(warnings(ctx)).toEqual([
      ['sampling-unsupported', `Guardrail "acme.on-topic"'s judge: ${SAMPLING.message}`],
    ]);
  });

  test('once per code: the turn keeps the first, the agent call included', async () => {
    const ctx = turn([judged('acme.on-topic'), judged('acme.polite')], judge([], [SAMPLING]));
    await buildEvaluateGuardrailsHandler(ctx)(finalAnswer, finalNode);
    expect(warnings(ctx)).toEqual([
      ['sampling-unsupported', `Guardrail "acme.on-topic"'s judge: ${SAMPLING.message}`],
    ]);

    const own = turn([judged('acme.on-topic')], judge([], [SAMPLING]));
    own.modelWarnings = new Map([
      ['sampling-unsupported', 'acme-large went without a temperature in the agent call.'],
    ]);
    await buildEvaluateGuardrailsHandler(own)(finalAnswer, finalNode);
    expect(warnings(own)).toEqual([
      ['sampling-unsupported', 'acme-large went without a temperature in the agent call.'],
    ]);
  });

  test('a judge that warned about nothing adds none', async () => {
    const ctx = turn([judged('acme.on-topic')], judge([]));
    await buildEvaluateGuardrailsHandler(ctx)(finalAnswer, finalNode);
    expect(ctx.modelWarnings).toBeUndefined();
  });
});

describe("a judge's warnings at a point inside the loop", () => {
  test("join the turn's, naming the guardrail", async () => {
    const calls: string[] = [];
    const ctx = turn([judged('acme.lookup-ok', 'before-tool')], judge(calls, [SAMPLING]));
    await lookupStep(ctx, new Map());
    expect(calls).toEqual(['judge']);
    expect(warnings(ctx)).toEqual([
      ['sampling-unsupported', `Guardrail "acme.lookup-ok"'s judge: ${SAMPLING.message}`],
    ]);
  });

  test('a step run again reads the judgment back, uncalled, and still says them', async () => {
    const calls: string[] = [];
    const records = new Map<string, unknown>();
    await lookupStep(
      turn([judged('acme.lookup-ok', 'before-tool')], judge(calls, [SAMPLING])),
      records,
    );
    const resumed = turn([judged('acme.lookup-ok', 'before-tool')], judge(calls, [SAMPLING]));
    await lookupStep(resumed, records);
    expect(calls).toEqual(['judge']);
    expect(warnings(resumed)).toEqual([
      ['sampling-unsupported', `Guardrail "acme.lookup-ok"'s judge: ${SAMPLING.message}`],
    ]);
  });
});
