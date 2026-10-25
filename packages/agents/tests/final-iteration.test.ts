// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelProvider } from '@kindgi/capabilities';
import { createProviderRegistry } from '@kindgi/capabilities';
import type { Guardrail } from '@kindgi/guardrails';
import { createCheckRegistry } from '@kindgi/guardrails';
import type { LoopNodeOutput, NodeContext } from '@kindgi/handler';
import type { GuardrailId, NodeId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { AGENT_LOOP_NODE } from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import type { AgentTurnIterationOutput, TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildEvaluateGuardrailsHandler } from '../src/handlers/evaluate-guardrails.js';
import { finalIteration } from '../src/handlers/final-iteration.js';
import { buildPersistFinalMessageHandler } from '../src/handlers/persist-final-message.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { TurnEvent } from '../src/streaming.js';
import type { ConversationId, ConversationMessage } from '../src/types.js';

import { testNodeContext } from './node-context.js';

const tenantId = 'acme' as TenantId;

const finished: AgentTurnIterationOutput = {
  finishReason: 'stop',
  message: { role: 'assistant', content: 'Here is the answer.' },
  iterationAppended: [],
  iterationUsage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
  provider: { id: 'judge-1', model: 'judge-1-model' },
  finishedTurn: true,
  nextMessages: [],
};

/** The model still wants a tool: dispatch ran it, and the turn goes on. */
const wantsTool: AgentTurnIterationOutput = {
  ...finished,
  finishReason: 'tool-use',
  message: {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', name: 'acme.lookup', arguments: {} }],
  },
  finishedTurn: false,
};

/** A typed answer that didn't fit: the turn asked for a repair. */
const repairing: AgentTurnIterationOutput = {
  ...finished,
  message: { role: 'assistant', content: 'not json' },
  finishedTurn: false,
};

function loop(
  finalOutput: AgentTurnIterationOutput,
  iterations: number,
  stopReason: LoopNodeOutput['stopReason'],
): LoopNodeOutput<AgentTurnIterationOutput> {
  return { finalOutput, iterations, stopReason };
}

/** The payload `read` fails the turn with. */
function failureOf(read: () => unknown): unknown {
  try {
    read();
  } catch (e) {
    expect(e).toBeInstanceOf(AgentTurnFailure);
    return (e as AgentTurnFailure).payload;
  }
  throw new Error('expected the read to fail the turn');
}

function stepsExceeded(observed: number, nodeName: string): unknown {
  return {
    code: 'budget-exceeded',
    message: `Agent turn steps budget exceeded (limit 32, observed ${observed}): a turn makes at most 32 model calls, and the last one did not finish the turn, so ${nodeName} has no answer`,
    kind: 'steps',
    limit: 32,
    observed,
  };
}

describe('finalIteration — only an iteration that finished the turn is an answer', () => {
  test('a finished iteration comes back as it is', () => {
    expect(finalIteration(loop(finished, 1, 'exit-condition'), 'reader')).toBe(finished);
  });

  test('a model that still wants a tool when the loop runs out fails the turn on its steps', () => {
    expect(
      failureOf(() => finalIteration(loop(wantsTool, 32, 'max-iterations'), 'reader')),
    ).toEqual(stepsExceeded(32, 'reader'));
  });

  test('a repair the loop ran out before fails the turn on its steps', () => {
    expect(
      failureOf(() => finalIteration(loop(repairing, 32, 'max-iterations'), 'reader')),
    ).toEqual(stepsExceeded(32, 'reader'));
  });

  test('an iteration without finishedTurn is unfinished', () => {
    const { finishedTurn: _, ...withoutField } = finished;
    const unmarked = withoutField as AgentTurnIterationOutput;
    expect(failureOf(() => finalIteration(loop(unmarked, 32, 'max-iterations'), 'reader'))).toEqual(
      stepsExceeded(32, 'reader'),
    );
  });

  test('observed is the iterations the loop ran, and limit the most it runs', () => {
    // Artificial: a real loop stops on max-iterations only at its 32nd
    // iteration. 7 keeps `observed` and `limit` apart.
    expect(failureOf(() => finalIteration(loop(wantsTool, 7, 'max-iterations'), 'reader'))).toEqual(
      stepsExceeded(7, 'reader'),
    );
  });

  test('an unfinished iteration that ended the loop any other way is broken loop output', () => {
    expect(failureOf(() => finalIteration(loop(wantsTool, 3, 'exit-condition'), 'reader'))).toEqual(
      {
        code: 'model-invocation-failed',
        message:
          'reader received loop output whose last iteration did not finish the turn (stopReason exit-condition, 3 iterations)',
        cause: null,
      },
    );
  });
});

function helper() {
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
  return agent.value;
}

function turnContext(bindings: Partial<InvokeAgentBindings>): TurnContext {
  return {
    input: {
      tenantId,
      projectId: 'p-1' as never,
      agent: helper(),
      conversationId: 'c-1' as ConversationId,
      userMessage: 'hi',
    },
    bindings: bindings as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 32, promptTokens: 1, completionTokens: 1, totalCostUsd: 0 },
    abortReason: undefined,
  };
}

describe('persist-final-message — an unfinished iteration is never stored', () => {
  function persisting() {
    const stored: unknown[] = [];
    const events: TurnEvent[] = [];
    const ctx = turnContext({
      conversationBinding: {
        appendMessage: async (input: { readonly content: string }) => {
          stored.push(input);
          const message: ConversationMessage = {
            sequence: 2,
            role: 'agent',
            content: input.content,
            createdAt: new Date().toISOString() as Timestamp,
            actor: 'acme.helper',
          };
          return { kind: 'ok', value: message };
        },
      } as unknown as InvokeAgentBindings['conversationBinding'],
      onEvent: (event) => void events.push(event),
    });
    const run = (output: LoopNodeOutput<AgentTurnIterationOutput>) =>
      buildPersistFinalMessageHandler(ctx)(
        undefined,
        testNodeContext({
          runId: 'run-1' as RunId,
          nodeOutputs: new Map([[AGENT_LOOP_NODE as NodeId, output]]),
          dryRun: false,
        }),
      );
    return { ctx, stored, events, run };
  }

  test('a finished iteration is stored', async () => {
    const { ctx, stored, events, run } = persisting();
    await run(loop(finished, 1, 'exit-condition'));
    expect(stored).toEqual([expect.objectContaining({ content: 'Here is the answer.' })]);
    expect(events.map((e) => e.kind)).toEqual(['agent.message']);
    expect(ctx.appended).toHaveLength(1);
    expect(ctx.finalMessage).toBeDefined();
  });

  test('an unfinished one fails the turn before anything is stored or sent', async () => {
    const { ctx, stored, events, run } = persisting();
    const thrown = await run(loop(wantsTool, 32, 'max-iterations')).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toEqual(
      stepsExceeded(32, 'persist-final-message'),
    );
    expect(stored).toEqual([]);
    expect(events).toEqual([]);
    expect(ctx.appended).toEqual([]);
    expect(ctx.finalMessage).toBeUndefined();
  });
});

describe('evaluate-guardrails — an unfinished iteration is never checked', () => {
  function evaluating() {
    const calls: string[] = [];
    const judge: ModelProvider = {
      metadata: {
        id: 'judge-1',
        region: 'eu-west-1',
        models: [
          {
            name: 'judge-1-model',
            contextWindow: 8000,
            features: ['tool-use'],
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
          provider: { id: 'judge-1', model: 'judge-1-model' },
        };
      },
    };
    const checks = createCheckRegistry();
    checks.register({
      id: 'acme.judge',
      kind: 'llm-judge',
      evaluate: async () => {
        calls.push('check');
        return { passed: true };
      },
    });
    const guardrail: Guardrail = {
      id: 'acme.helpful' as GuardrailId,
      kind: 'llm-judge',
      check: 'acme.judge',
      config: { rubric: 'Is the response helpful?' },
      action: { 'on-violation': 'log-only' },
      judgeCapabilities: { needs: [{ feature: 'tool-use' }] },
    };
    const { registry: providerRegistry } = createProviderRegistry([{ tenantId, provider: judge }]);
    const ctx: TurnContext = {
      ...turnContext({ providerRegistry, checks }),
      guardrails: [guardrail],
    };
    const run = (output: LoopNodeOutput<AgentTurnIterationOutput>) =>
      buildEvaluateGuardrailsHandler(ctx)(output, {} as NodeContext);
    return { calls, run };
  }

  test('a finished iteration is checked', async () => {
    const { calls, run } = evaluating();
    await run(loop(finished, 1, 'exit-condition'));
    expect(calls).not.toEqual([]);
  });

  test('an unfinished one fails the turn before any guardrail runs', async () => {
    const { calls, run } = evaluating();
    const thrown = await run(loop(wantsTool, 32, 'max-iterations')).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AgentTurnFailure);
    expect((thrown as AgentTurnFailure).payload).toEqual(stepsExceeded(32, 'evaluate-guardrails'));
    expect(calls).toEqual([]);
  });
});
