// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The turn's step cap and its loop. `agent-loop` runs at most
 * `AGENT_TURN_LOOP_MAX_ITERATIONS` iterations, one model call each, and
 * `budget-check` decides at the end of each whether the turn goes on.
 */

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import { isLoopNode } from '@kindgi/flow';
import type { NodeContext } from '@kindgi/handler';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';

import {
  AGENT_LOOP_NODE,
  AGENT_TURN_FLOW,
  AGENT_TURN_LOOP_MAX_ITERATIONS,
} from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import { buildBudgetCheckHandler } from '../src/handlers/budget-check.js';
import type { AgentTurnIterationOutput, TurnContext } from '../src/handlers/context.js';
import { parseFailureMessage } from '../src/handlers/errors.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import { repairsSoFar } from '../src/handlers/structured-output.js';
import type { Agent, AgentOutputSpec, ConversationId } from '../src/types.js';

const tenantId = 'acme' as TenantId;
const projectId = '00000000-0000-0000-0000-0000000000aa' as ProjectId;
const conversationId = '00000000-0000-0000-0000-0000000000cc' as ConversationId;
const runId = '00000000-0000-0000-0000-0000000000dd' as RunId;

const ORDER: AgentOutputSpec = {
  name: 'order',
  schema: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
    additionalProperties: false,
  },
};

function agent(extra: Record<string, unknown> = {}): Agent {
  const r = defineAgent({
    id: 'acme.order-desk',
    version: '1.0.0',
    name: 'Order desk',
    instructions: 'Find the order and answer.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    ...extra,
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

/** A turn context whose model calls so far are `steps`. */
function ctxAt(a: Agent, steps: number): TurnContext {
  return {
    input: { tenantId, projectId, agent: a, conversationId, userMessage: 'go' },
    bindings: {} as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
  };
}

const kctx = { runId, dryRun: false, nodeId: 'n' as NodeId } as unknown as NodeContext;

/** The iteration so far: the model's message, and whether it asked for tools. */
function iteration(step: number, content: string, hasToolCalls: boolean) {
  const sent: readonly ModelMessage[] = [{ role: 'user', content: 'go' }];
  return {
    step,
    finishReason: hasToolCalls ? 'tool-use' : 'stop',
    message: { role: 'assistant', content },
    iterationAppended: [],
    iterationUsage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    provider: { id: 'p', model: 'm' },
    nextMessages: sent,
    hasToolCalls,
  };
}

async function check(a: Agent, steps: number, it: ReturnType<typeof iteration>) {
  return (await buildBudgetCheckHandler(ctxAt(a, steps))(it, kctx)) as AgentTurnIterationOutput;
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (cause) {
    return parseFailureMessage((cause as Error).message);
  }
  throw new Error('expected the handler to fail');
}

describe("the turn's loop", () => {
  test(`runs at most AGENT_TURN_LOOP_MAX_ITERATIONS (${AGENT_TURN_LOOP_MAX_ITERATIONS}) iterations`, () => {
    const loop = AGENT_TURN_FLOW.nodes.find((n) => n.id === AGENT_LOOP_NODE);
    if (loop === undefined || !isLoopNode(loop)) throw new Error('loop node missing');
    expect(AGENT_TURN_LOOP_MAX_ITERATIONS).toBe(32);
    expect(loop.maxIterations).toBe(AGENT_TURN_LOOP_MAX_ITERATIONS);
  });
});

describe('a maxSteps above the loop', () => {
  const wide = agent({ budget: { maxSteps: 64 } });

  test('the last iteration asks for a tool: the turn goes on, past the loop', async () => {
    const out = await check(wide, 32, iteration(32, '', true));
    expect(out.finishedTurn).toBe(false);
  });

  test('a typed answer that does not fit on the last iteration: a repair the loop never makes', async () => {
    const typed = agent({ budget: { maxSteps: 64 }, output: ORDER });
    const out = await check(typed, 32, iteration(32, 'not json', false));
    expect(out.finishedTurn).toBe(false);
    expect(repairsSoFar(out.nextMessages)).toBe(1);
  });
});

describe('a maxSteps the loop can run', () => {
  test('the default, 8: the 8th model call asking for a tool fails the turn', async () => {
    const error = await failureOf(() => check(agent(), 8, iteration(8, '', true)));
    expect(error).toEqual({
      code: 'budget-exceeded',
      message: 'Agent turn steps budget exceeded (limit 8, observed 8)',
      kind: 'steps',
      limit: 8,
      observed: 8,
    });
  });

  test('maxSteps 32, the loop: the 32nd fails the same way', async () => {
    const a = agent({ budget: { maxSteps: 32 } });
    expect((await check(a, 31, iteration(31, '', true))).finishedTurn).toBe(false);
    const error = await failureOf(() => check(a, 32, iteration(32, '', true)));
    expect(error).toEqual({
      code: 'budget-exceeded',
      message: 'Agent turn steps budget exceeded (limit 32, observed 32)',
      kind: 'steps',
      limit: 32,
      observed: 32,
    });
  });

  test('maxSteps 32, a typed answer that does not fit on the 32nd: no repair, the turn fails', async () => {
    const a = agent({ budget: { maxSteps: 32 }, output: ORDER });
    const error = await failureOf(() => check(a, 32, iteration(32, 'not json', false)));
    expect(error).toMatchObject({ code: 'output-schema-violation', attempts: 1 });
  });
});
