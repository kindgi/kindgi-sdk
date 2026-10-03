// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelMessage, ModelProvider } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { JournalEntry } from '@kindgi/runtime';
import { createToolRegistry, defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, Semver, TenantId, Timestamp, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { rehydrateTurnContext } from '../src/handlers/rehydrate.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { AgentId, ConversationMessage } from '../src/types.js';

const tenantId = 't-1' as TenantId;

function provider(id: string): ModelProvider {
  return {
    metadata: {
      id,
      region: 'unspecified',
      models: [
        {
          name: `${id}-model`,
          contextWindow: 128_000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
        },
      ],
    },
    invoke: async () => {
      throw new Error('not called');
    },
  };
}

function agent() {
  const r = defineAgent({
    id: 'pack.agent' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Agent',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    preferredProvider: 'first',
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

const message = (
  sequence: number,
  role: ConversationMessage['role'],
  extra: Record<string, unknown> = {},
): ConversationMessage =>
  ({
    sequence,
    role,
    content: `${role} ${sequence}`,
    createdAt: '2026-10-01T00:00:00Z',
    ...extra,
  }) as never;

const toolCalls = (...ids: string[]) => ({
  content: { text: '', toolCalls: ids.map((id) => ({ id, name: 'pack.lookup', arguments: {} })) },
});
const resultOf = (id: string) => ({
  content: { found: id },
  toolCall: { toolId: 'pack.lookup', invocationId: id },
});

/**
 * The conversation: an earlier turn (1–2), then this one — its user
 * message (3), the first iteration's call and result (4–5), and the
 * second iteration's two calls (6), of which the first ran (7) and the
 * second waits for approval.
 */
const stored = [
  message(1, 'user'),
  message(2, 'agent'),
  message(3, 'user'),
  message(4, 'agent', toolCalls('c1')),
  message(5, 'tool', resultOf('c1')),
  message(6, 'agent', toolCalls('c2', 'c3')),
  message(7, 'tool', resultOf('c2')),
];

/** A turn being resumed: nothing on it yet but what `resumeAgentTurn` builds. */
function resumedTurn(providers: readonly ModelProvider[]) {
  const a = agent();
  const ctx = {
    input: { tenantId, conversationId: 'conv-1', agent: a },
    bindings: {
      conversationBinding: {
        getConversation: async () => ({
          kind: 'ok',
          value: { id: 'conv-1', agentId: a.id, agentVersion: a.version, turnCount: 1 },
        }),
        readMessages: async ({ sinceSequence }: { readonly sinceSequence: number }) => ({
          kind: 'ok',
          value: stored.filter((m) => m.sequence > sinceSequence),
        }),
      },
      toolRegistry: createToolRegistry([]),
      providerRegistry: createProviderRegistry(providers.map((p) => ({ tenantId, provider: p })))
        .registry,
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnContext;
  return ctx;
}

let sequence = 0;
const completed = (nodeId: string, output: unknown, iteration?: number): JournalEntry =>
  ({
    sequence: ++sequence,
    kind: 'step.completed',
    nodeId,
    payload: {
      output,
      ...(iteration !== undefined && {
        loopContext: {
          loopNodeId: 'agent-loop',
          iteration,
          path: [{ loopNodeId: 'agent-loop', iteration }],
        },
      }),
    },
    timestamp: '2026-10-01T00:00:00Z' as Timestamp,
  }) as JournalEntry;

const firstModelCall = completed(
  'model-call',
  {
    step: 1,
    iterationUsage: { promptTokens: 10, completionTokens: 2, costUsd: 0.01 },
    provider: { id: 'second', model: 'second-model' },
  },
  0,
);

/** A turn parked on a tool-call approval in its second loop iteration. */
const parkedJournal: readonly JournalEntry[] = [
  completed('setup', {
    turnNumber: 2,
    providerId: 'second',
    providerModel: 'second-model',
    toolCount: 0,
  }),
  completed('render-prompt', {}),
  completed('persist-user-message', { sequence: 3 }),
  completed('run-retrievals', { count: 1, retrieved: [{ intent: 'facts', content: 'a fact' }] }),
  completed('build-initial-messages', {}),
  firstModelCall,
  completed('dispatch-tools', { iterationAppended: [stored[3], stored[4]] }, 0),
  completed('budget-check', {}, 0),
  // A step at one iteration counts once, however often it was journaled.
  { ...firstModelCall, sequence: ++sequence },
  completed(
    'model-call',
    {
      step: 2,
      iterationUsage: { promptTokens: 20, completionTokens: 3, costUsd: 0.02 },
      provider: { id: 'second', model: 'second-model' },
    },
    1,
  ),
];

describe('rehydrateTurnContext', () => {
  test('a turn parked before setup completed is left to setup', async () => {
    const ctx = resumedTurn([provider('first')]);
    expect(await rehydrateTurnContext(ctx, 'run-1', [])).toBe(false);
    expect(ctx.provider).toBeUndefined();
    expect(ctx.conversation).toBeUndefined();
  });

  test("restores what the completed steps left on the turn, routed to setup's model", async () => {
    const ctx = resumedTurn([provider('first'), provider('second')]);
    expect(await rehydrateTurnContext(ctx, 'run-1', parkedJournal)).toBe(true);

    // The agent prefers `first`, but the turn was routed to `second`.
    expect(ctx.provider?.metadata.id).toBe('second');
    expect(ctx.model?.name).toBe('second-model');
    expect(ctx.conversation?.turnCount).toBe(1);
    expect(ctx.tools?.definitions).toEqual([]);
    expect(ctx.guardrails).toEqual([]);
    expect(ctx.toolErrorPolicy?.maxRetries).toBe(1);
    // The messages this turn stored, from its user message on; of them,
    // the ones the parked step stored.
    expect(ctx.appended.map((m) => m.sequence)).toEqual([3, 4, 5, 6, 7]);
    expect(ctx.storedBeforePark?.map((m) => m.sequence)).toEqual([6, 7]);
    expect(ctx.userMessage?.sequence).toBe(3);
    expect(ctx.retrieved).toEqual([{ intent: 'facts', content: 'a fact' }]);
    // Usage across both model calls, so the budgets count the whole turn.
    expect(ctx.usage).toEqual({
      steps: 2,
      promptTokens: 30,
      completionTokens: 5,
      totalCostUsd: expect.closeTo(0.03),
    });
    expect(ctx.lastProvider).toEqual({ id: 'second', model: 'second-model' });
  });

  test("fails the turn when setup's model is no longer registered", async () => {
    const ctx = resumedTurn([provider('first')]);
    let failure: unknown;
    try {
      await rehydrateTurnContext(ctx, 'run-1', parkedJournal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgentTurnFailure);
    expect((failure as AgentTurnFailure).payload).toMatchObject({
      code: 'capability-routing-failed',
      message: expect.stringContaining('second/second-model'),
    });
  });
});

describe('dispatch-tools, resumed in the step it parked in', () => {
  test('takes the stored assistant message and the results of calls that ran; runs the rest', async () => {
    const ran: unknown[] = [];
    const defined = defineTool<{ q: string }, { found: string }>({
      id: 'pack.lookup' as ToolId,
      description: 'Looks something up.',
      version: '1.0.0',
      input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
      output: {
        type: 'object',
        properties: { found: { type: 'string' } },
        required: ['found'],
        additionalProperties: false,
      },
      effects: [],
      handler: async (input) => {
        ran.push(input);
        return { found: input.q };
      },
    });
    if (defined.kind === 'err') throw new Error(defined.error.message);
    const tool = defined.value as unknown as AnyTool;
    const appendedNow: Record<string, unknown>[] = [];
    const a = agent();
    const ctx = {
      input: { tenantId, conversationId: 'conv-1', agent: a },
      bindings: {
        conversationBinding: {
          appendMessage: async (m: Record<string, unknown>) => {
            appendedNow.push(m);
            return { kind: 'ok', value: { sequence: 8, createdAt: '2026-10-01T00:00:00Z', ...m } };
          },
        },
      },
      tools: {
        definitions: [],
        byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
      },
      turnAbort: new AbortController(),
      hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent: a }),
      appended: stored.slice(2),
      storedBeforePark: [stored[5], stored[6]],
    } as unknown as TurnContext;

    const out = (await buildDispatchToolsHandler(ctx)(
      {
        step: 2,
        finishReason: 'tool-use',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c2', name: 'pack.lookup', arguments: { q: 'two' } },
            { id: 'c3', name: 'pack.lookup', arguments: { q: 'three' } },
          ],
        },
        iterationUsage: { promptTokens: 0, completionTokens: 0 },
        provider: { id: 'second', model: 'second-model' },
        nextMessages: [{ role: 'user', content: 'look them up' }],
      },
      { runId: 'run-1' as RunId } as unknown as NodeContext,
    )) as {
      readonly iterationAppended: readonly ConversationMessage[];
      readonly nextMessages: readonly ModelMessage[];
    };

    // Only the call that hadn't run ran, and only its result was stored.
    expect(ran).toEqual([{ q: 'three' }]);
    expect(appendedNow).toHaveLength(1);
    expect(appendedNow[0]).toMatchObject({ role: 'tool', toolCall: { invocationId: 'c3' } });
    expect(out.iterationAppended.map((m) => m.sequence)).toEqual([6, 7, 8]);
    expect(out.nextMessages.slice(2)).toEqual([
      { role: 'tool', content: JSON.stringify({ found: 'c2' }), toolCallId: 'c2' },
      { role: 'tool', content: JSON.stringify({ found: 'three' }), toolCallId: 'c3' },
    ]);
    expect(ctx.storedBeforePark).toEqual([]);
    expect(ctx.appended.map((m) => m.sequence)).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
