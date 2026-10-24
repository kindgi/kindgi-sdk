// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A model's thinking, carried in its answer's first tool call (`signature`),
 * outlives the process that got it. Each loop step's output is journaled as
 * JSON and handed to the next step after a restart; each tool-call message is
 * stored with its calls and read back as a later turn's history. Here the
 * Anthropic adapter, with a stubbed client, answers with thinking and a tool
 * call; the call after a restart, and a later turn's first call, send that
 * thinking back as Anthropic answered it. An answer whose thinking took the
 * whole cap reaches the turn's result with the adapter's warning.
 */

import { describe, expect, test, vi } from 'vitest';

import { createAnthropicProvider } from '@kindgi/adapter-model-anthropic';
import type { ModelMessage, ModelProvider } from '@kindgi/capabilities';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { NodeId, RunId, TenantId, ToolId } from '@kindgi/types';

import {
  AGENT_LOOP_NODE,
  BUDGET_CHECK_NODE,
  BUILD_INITIAL_MESSAGES_NODE,
  COMPOSE_RESULT_NODE,
  DISPATCH_TOOLS_NODE,
  MODEL_CALL_NODE,
  PERSIST_FINAL_MESSAGE_NODE,
} from '../src/agent-turn-flow.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildHandlers } from '../src/handlers/index.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent, ConversationMessage } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const MODEL = {
  name: 'claude-sonnet-5-5',
  contextWindow: 200_000,
  features: ['tool-use' as const],
  cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
};

const THINKING = {
  type: 'thinking',
  thinking: 'The order number is in the message: look it up first.',
  signature: 'EqQBCkgIBxABGAIiQL…',
};

/** What Anthropic answers: thinking, a line of text and a tool call; then the answer. */
function anthropic() {
  const create = vi.fn(async (body: { readonly messages: readonly unknown[] }) => {
    const answered = body.messages.some(
      (m) => (m as { readonly role: string }).role === 'assistant',
    );
    const last = body.messages.at(-1) as { readonly content: readonly { type: string }[] };
    const toolResult = last.content.some((b) => b.type === 'tool_result');
    return {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: MODEL.name,
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 20 },
      ...(toolResult || answered
        ? { content: [{ type: 'text', text: 'It shipped.' }], stop_reason: 'end_turn' }
        : {
            content: [
              THINKING,
              { type: 'text', text: 'Let me look.' },
              { type: 'tool_use', id: 'tu-1', name: 'acme__lookup', input: { order: 'A-1' } },
            ],
            stop_reason: 'tool_use',
          }),
    };
  });
  const provider = createAnthropicProvider({
    apiKey: 'sk-unused',
    metadata: { id: 'anthropic', region: 'us-east-1', models: [MODEL] },
    client: { messages: { create } } as never,
  });
  /** The assistant blocks of the `n`th call's request. */
  const sent = (n: number) =>
    (
      create.mock.calls[n]?.[0] as {
        readonly messages: readonly { readonly role: string; readonly content: unknown }[];
      }
    ).messages.filter((m) => m.role === 'assistant');
  return { provider, create, sent };
}

function lookupTool(): AnyTool {
  const defined = defineTool<{ order: string }, { status: string }>({
    id: 'acme.lookup' as ToolId,
    description: 'Looks an order up.',
    version: '1.0.0',
    input: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] },
    output: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    effects: [],
    handler: async () => ({ status: 'shipped' }),
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

const agent = { id: 'acme.desk', version: '1.0.0', retrieval: [] } as unknown as Agent;

/** A turn set up on `provider`: what setup leaves on it, and a conversation store. */
function turn(provider: ModelProvider, history: readonly ConversationMessage[] = []) {
  const tool = lookupTool();
  const stored: Record<string, unknown>[] = [];
  let sequence = history.length;
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      conversationId: 'conv-1',
      agent,
      userMessage: 'Where is order A-1?',
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          stored.push(m);
          return { kind: 'ok', value: { id: `msg-${++sequence}`, sequence, ...m } };
        },
        readMessages: async () => ({ kind: 'ok', value: history }),
      },
    },
    provider,
    model: MODEL,
    tools: {
      definitions: [
        { name: 'acme.lookup', description: 'Looks an order up.', inputSchema: tool.input },
      ],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    conversation: { id: 'conv-1', turnCount: history.length > 0 ? 1 : 0 },
    retrieved: [],
    renderedPrompt: 'Answer questions about orders.',
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
  } as unknown as TurnContext;
  const handlers = buildHandlers(ctx);
  const records = new Map<string, unknown>();
  const nodeOutputs = new Map<NodeId, unknown>();
  const kctx = testNodeContext(
    { runId: 'run-1' as RunId, dryRun: false, nodeOutputs } as never,
    records,
  );
  /** Runs a step, and returns its output as the journal keeps it: JSON. */
  const step = async (node: string, input: unknown): Promise<unknown> => {
    const handler = handlers.get(node as NodeId);
    if (handler === undefined) throw new Error(`no ${node} handler`);
    return JSON.parse(JSON.stringify(await handler(input, kctx)));
  };
  return { ctx, stored, step, nodeOutputs };
}

const initial: ModelMessage[] = [
  { role: 'system', content: 'Answer questions about orders.' },
  { role: 'user', content: 'Where is order A-1?' },
];

const answeredWithThinking = [
  THINKING,
  { type: 'text', text: 'Let me look.' },
  { type: 'tool_use', id: 'tu-1', name: 'acme__lookup', input: { order: 'A-1' } },
];

describe('thinking carried in a tool call outlives the process', () => {
  test("after a restart, the turn's next call sends the journaled answer's thinking back", async () => {
    // The first process: the model call, its tools, the iteration's end.
    const first = anthropic();
    const before = turn(first.provider);
    const called = await before.step(MODEL_CALL_NODE, { nextMessages: initial });
    const dispatched = await before.step(DISPATCH_TOOLS_NODE, called);
    const iterationEnd = (await before.step(BUDGET_CHECK_NODE, dispatched)) as {
      readonly finishedTurn: boolean;
    };
    expect(iterationEnd.finishedTurn).toBe(false);

    // A new process: a new provider and client, given the journaled output.
    const second = anthropic();
    const after = turn(second.provider);
    await after.step(MODEL_CALL_NODE, iterationEnd);

    expect(second.create).toHaveBeenCalledTimes(1);
    expect(second.sent(0)).toEqual([{ role: 'assistant', content: answeredWithThinking }]);
  });

  test("a later turn's first call sends back the thinking of the stored tool-call message", async () => {
    const first = anthropic();
    const earlier = turn(first.provider);
    const called = await earlier.step(MODEL_CALL_NODE, { nextMessages: initial });
    await earlier.step(DISPATCH_TOOLS_NODE, called);
    // The conversation as stored (jsonb), the earlier turn's answer last.
    const history = [
      { role: 'user', content: 'Where is order A-1?' },
      ...earlier.stored,
      { role: 'agent', content: 'It shipped.' },
    ].map(
      (m, i) =>
        JSON.parse(
          JSON.stringify({ ...m, sequence: i + 1, createdAt: '2026-10-01T00:00:00Z' }),
        ) as ConversationMessage,
    );

    const next = anthropic();
    const later = turn(next.provider, history);
    const built = await later.step(BUILD_INITIAL_MESSAGES_NODE, {});
    await later.step(MODEL_CALL_NODE, built);

    expect(next.sent(0)).toEqual([
      { role: 'assistant', content: answeredWithThinking },
      { role: 'assistant', content: [{ type: 'text', text: 'It shipped.' }] },
    ]);
  });
});

describe('an answer whose thinking took the whole cap', () => {
  test("ends the turn with an empty answer, and the turn's result carries the adapter's warning", async () => {
    const create = vi.fn(async () => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: MODEL.name,
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 4096 },
      content: [THINKING],
      stop_reason: 'max_tokens',
    }));
    const provider = createAnthropicProvider({
      apiKey: 'sk-unused',
      metadata: { id: 'anthropic', region: 'us-east-1', models: [MODEL] },
      client: { messages: { create } } as never,
    });
    const { step, nodeOutputs } = turn(provider);
    const called = await step(MODEL_CALL_NODE, { nextMessages: initial });
    const dispatched = await step(DISPATCH_TOOLS_NODE, called);
    const iterationEnd = (await step(BUDGET_CHECK_NODE, dispatched)) as {
      readonly finishedTurn: boolean;
    };
    expect(iterationEnd.finishedTurn).toBe(true);
    nodeOutputs.set(AGENT_LOOP_NODE as NodeId, {
      finalOutput: iterationEnd,
      iterations: 1,
      stopReason: 'exit-condition',
    });
    await step(PERSIST_FINAL_MESSAGE_NODE, undefined);
    const { output } = (await step(COMPOSE_RESULT_NODE, undefined)) as {
      readonly output: {
        readonly response: { readonly content: unknown };
        readonly warnings?: readonly { readonly code: string; readonly message: string }[];
      };
    };

    expect(output.response.content).toBe('');
    expect(output.warnings).toEqual([
      {
        code: 'thinking-used-max-tokens',
        message:
          "claude-sonnet-5-5 used all 4096 output tokens, its thinking included, and gave no answer: raise maxOutputTokens in the agent's model-settings block or on the provider's model.",
      },
    ]);
  });
});
