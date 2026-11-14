// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A typed agent's repairs are the turn's own: `repairsSoFar` counts the
 * repair messages the turn's loop added, after its initial ones
 * (`ctx.initialMessageCount`). A message of the person's that starts
 * with the repair marker, this turn's or one in the history, uses up no
 * repair.
 */

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import { buildBudgetCheckHandler } from '../src/handlers/budget-check.js';
import { buildBuildInitialMessagesHandler } from '../src/handlers/build-initial-messages.js';
import type { AgentTurnIterationOutput, TurnContext } from '../src/handlers/context.js';
import { parseFailureMessage } from '../src/handlers/errors.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import { repairsSoFar } from '../src/handlers/structured-output.js';
import type { Agent, AgentOutputSpec, ConversationId, ConversationMessage } from '../src/types.js';

const tenantId = 'acme' as TenantId;
const projectId = '00000000-0000-0000-0000-0000000000aa' as ProjectId;
const conversationId = '00000000-0000-0000-0000-0000000000cc' as ConversationId;
const runId = '00000000-0000-0000-0000-0000000000dd' as RunId;

/** The words a repair request starts with. */
const MARKER = '[kindgi:output-repair]';

const ORDER: AgentOutputSpec = {
  name: 'order',
  schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
};

/** A typed agent with the default one repair. */
function agent(): Agent {
  const r = defineAgent({
    id: 'acme.order-lookup',
    version: '1.0.0',
    name: 'Order lookup',
    instructions: 'Find the order.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    output: ORDER,
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

/** A turn whose person wrote `userMessage`; where its loop starts is unset. */
function turn(userMessage: string): TurnContext {
  return {
    input: { tenantId, projectId, agent: agent(), conversationId, userMessage },
    bindings: {} as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
  };
}

const kctx = { runId, dryRun: false, nodeId: 'n' as NodeId } as unknown as NodeContext;

/** budget-check on the model's final answer `content`, after `sent`. */
async function check(
  ctx: TurnContext,
  content: string,
  sent: readonly ModelMessage[],
): Promise<AgentTurnIterationOutput> {
  const iteration = {
    step: ctx.usage.steps,
    finishReason: 'stop',
    message: { role: 'assistant', content },
    iterationAppended: [],
    iterationUsage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    provider: { id: 'p', model: 'm' },
    nextMessages: sent,
    hasToolCalls: false,
  };
  return (await buildBudgetCheckHandler(ctx)(iteration, kctx)) as AgentTurnIterationOutput;
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (cause) {
    return parseFailureMessage((cause as Error).message);
  }
  throw new Error('expected the handler to fail');
}

describe("a typed agent's repairs count from where the turn's loop starts", () => {
  test("a person's message that starts with the marker, this turn's or the history's, uses up no repair", async () => {
    const asked = `${MARKER} Where is order A-1042?`;
    const ctx = turn(asked);
    // The system message, a history message and the person's message: all theirs.
    const initial: ModelMessage[] = [
      { role: 'system', content: 'Find the order.' },
      { role: 'user', content: `${MARKER} An earlier question` },
      { role: 'user', content: asked },
    ];
    ctx.initialMessageCount = initial.length;
    const first = await check(ctx, 'not json', initial);
    // The turn's one repair, asked for: theirs used none of it.
    expect(first.finishedTurn).toBe(false);
    expect(first.nextMessages.slice(0, 4)).toEqual([
      ...initial,
      { role: 'assistant', content: 'not json' },
    ]);
    expect(repairsSoFar(ctx, first.nextMessages)).toBe(1);
    const error = await failureOf(() => check(ctx, '{"id":7}', first.nextMessages));
    expect(error).toMatchObject({
      code: 'output-schema-violation',
      errors: ['/id must be string'],
      attempts: 2,
    });
  });

  test("build-initial-messages names where the loop starts: after the history and the person's message", async () => {
    const asked = `${MARKER} Where is order A-1042?`;
    const ctx = turn(asked);
    const at = '2026-11-07T09:00:00.000Z' as ConversationMessage['createdAt'];
    const history: readonly ConversationMessage[] = [
      { sequence: 0, role: 'user', content: `${MARKER} An earlier question`, createdAt: at },
      { sequence: 1, role: 'agent', content: '{"id":"A-1041"}', createdAt: at },
    ];
    Object.assign(ctx, {
      bindings: {
        conversationBinding: { readMessages: async () => ({ kind: 'ok', value: history }) },
      },
      conversation: { id: conversationId, tenantId, projectId },
      retrieved: [],
      renderedPrompt: 'Find the order.',
      userMessage: { sequence: 2, role: 'user', content: asked },
      tools: { definitions: [], byName: new Map() },
    });
    const initial = (await buildBuildInitialMessagesHandler(ctx)(undefined, kctx)) as {
      readonly nextMessages: readonly ModelMessage[];
    };
    // The system message, the history's two, and the person's message.
    expect(initial.nextMessages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(ctx.initialMessageCount).toBe(4);
    const first = await check(ctx, 'not json', initial.nextMessages);
    expect(first.finishedTurn).toBe(false);
    expect(repairsSoFar(ctx, first.nextMessages)).toBe(1);
  });

  test('read before build-initial-messages completed: the turn fails, rather than count from the start', async () => {
    const ctx = turn('Where is order A-1042?');
    const sent: ModelMessage[] = [{ role: 'user', content: 'Where is order A-1042?' }];
    const error = await failureOf(() => check(ctx, 'not json', sent));
    expect(error).toMatchObject({
      code: 'model-invocation-failed',
      message: "the turn's output repairs were read before build-initial-messages completed",
    });
  });
});
