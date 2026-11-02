// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The model-call step records every model call in the usage sink (the
 * runtime's cost ledger) before it goes on: an answer with its usage and
 * what the vendor said about it, a call that threw as failed. A sink
 * that can't record fails the step. Its provenance node keeps the call's
 * identity (provider, model, call id), not its usage. A dry run records
 * nothing.
 */

import { describe, expect, test } from 'vitest';

import { createAttemptCounter } from '@kindgi/capabilities/attempts';

import type {
  ModelCallResult,
  ModelInfo,
  ModelProvider,
  ModelUsageRecord,
  ProviderMetadata,
  UsageSink,
} from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildModelCallHandler } from '../src/handlers/model-call.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { ConversationId } from '../src/types.js';

const ANSWER: ModelCallResult = {
  message: { role: 'assistant', content: 'done' },
  finishReason: 'stop',
  usage: { promptTokens: 1200, completionTokens: 80, cacheReadTokens: 1000, reasoningTokens: 30 },
  costUsd: 0.0021,
  durationMs: 640,
  provider: { id: 'anthropic', model: 'claude-haiku-4-5' },
  servedModel: 'claude-haiku-4-5-20251001',
  providerRequestId: 'req_1',
  attempts: 2,
  rawUsage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 1000 },
};

interface Turn {
  readonly ctx: TurnContext;
  readonly recorded: ModelUsageRecord[];
  readonly nodes: { readonly id: string; readonly attributes?: Record<string, unknown> }[];
  readonly events: { readonly kind: string; readonly thinking?: unknown }[];
}

function turn(options: {
  readonly invoke: ModelProvider['invoke'];
  readonly sink?: UsageSink | 'none';
  readonly fallback?: boolean;
  /** The pinned model-settings block's values. */
  readonly modelSettings?: Readonly<Record<string, unknown>>;
}): Turn {
  const agent = defineAgent({
    id: 'acme.helper',
    version: '1.2.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (agent.kind === 'err') throw new Error(JSON.stringify(agent.error.issues));
  const recorded: ModelUsageRecord[] = [];
  const nodes: Turn['nodes'] = [];
  const events: Turn['events'] = [];
  const sink: UsageSink | undefined =
    options.sink === 'none'
      ? undefined
      : (options.sink ?? {
          record: async (call) => {
            recorded.push(call);
          },
        });
  const ctx = {
    input: {
      tenantId: 'acme' as TenantId,
      projectId: '00000000-0000-0000-0000-0000000000aa' as ProjectId,
      agent: agent.value,
      conversationId: '00000000-0000-0000-0000-0000000000cc' as ConversationId,
      userMessage: 'hi',
    },
    bindings: {
      ...(sink !== undefined && { usage: sink }),
      onEvent: (event: Turn['events'][number]) => {
        events.push(event);
      },
    } as unknown as InvokeAgentBindings,
    ...(options.modelSettings !== undefined && {
      blocks: { modelSettings: options.modelSettings },
    }),
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
    provider: {
      metadata: {
        id: 'anthropic',
        ...(options.fallback === true && { fallback: true }),
      } as ProviderMetadata,
      invoke: options.invoke,
    },
    model: {
      name: 'claude-haiku-4-5',
      features: [],
      contextWindow: 200_000,
    } as unknown as ModelInfo,
    tools: { definitions: [], byName: new Map() },
    userMessage: { sequence: 1 },
    provenance: {
      addNode: (node: Turn['nodes'][number]) => nodes.push(node),
      addEdge: () => undefined,
    },
  } as unknown as TurnContext;
  return { ctx, recorded, nodes, events };
}

const kctx = (dryRun = false) =>
  ({
    runId: 'run-1' as RunId,
    nodeId: 'model-call' as NodeId,
    dryRun,
  }) as unknown as NodeContext;

async function failureOf(p: Promise<unknown>): Promise<AgentTurnFailure> {
  const thrown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(AgentTurnFailure);
  return thrown as AgentTurnFailure;
}

describe('model-call records each call in the usage sink', () => {
  test("an answer: the turn's identity, the provider's usage and what the vendor said, never the messages", async () => {
    const t = turn({ invoke: async () => ANSWER });
    const out = (await buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx())) as {
      readonly callId: string;
    };

    expect(t.recorded).toHaveLength(1);
    const call = t.recorded[0];
    expect(call).toEqual({
      callId: out.callId,
      tenantId: 'acme',
      projectId: '00000000-0000-0000-0000-0000000000aa',
      runId: 'run-1',
      agentId: 'acme.helper',
      agentVersion: '1.2.0',
      conversationId: '00000000-0000-0000-0000-0000000000cc',
      nodeId: 'model-call',
      step: 1,
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
      occurredAt: expect.any(String),
      status: 'ok',
      result: {
        finishReason: 'stop',
        usage: ANSWER.usage,
        costUsd: 0.0021,
        durationMs: 640,
        provider: ANSWER.provider,
        servedModel: 'claude-haiku-4-5-20251001',
        providerRequestId: 'req_1',
        attempts: 2,
        rawUsage: ANSWER.rawUsage,
      },
      durationMs: 640,
    });
    expect(JSON.stringify(call)).not.toContain('done');
  });

  test('the provenance node keeps the call: its id, provider and model; its usage is the ledger’s', async () => {
    const t = turn({ invoke: async () => ANSWER });
    const out = (await buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx())) as {
      readonly callId: string;
    };
    expect(t.nodes).toEqual([
      expect.objectContaining({
        id: 'model-call:1',
        attributes: {
          step: 1,
          callId: out.callId,
          providerId: 'anthropic',
          model: 'claude-haiku-4-5',
          finishReason: 'stop',
        },
      }),
    ]);
  });

  test('a call that threw is recorded as failed, and the turn still fails with the provider’s words', async () => {
    const t = turn({ invoke: () => Promise.reject(new Error('529 overloaded')) });
    const { payload } = await failureOf(buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx()));
    expect(payload.code).toBe('model-invocation-failed');
    expect(t.recorded).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: { message: '529 overloaded' },
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
        durationMs: expect.any(Number),
      }),
    ]);
    expect(t.recorded[0]?.result).toBeUndefined();
  });

  test('a failed call records the attempts it took', async () => {
    const counter = createAttemptCounter(async () => new Response('overloaded', { status: 529 }));
    const t = turn({
      invoke: () =>
        counter
          .count(async () => {
            await counter.fetch('https://vendor.test');
            await counter.fetch('https://vendor.test');
            throw new Error('529 overloaded');
          })
          .then(() => ANSWER),
    });
    await failureOf(buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx()));
    expect(t.recorded[0]?.error).toEqual({ message: '529 overloaded', attempts: 2 });
  });

  test('a failed call whose record fails too keeps its own failure, and says it went unrecorded', async () => {
    const providerError = new Error('529 overloaded');
    const t = turn({
      invoke: () => Promise.reject(providerError),
      sink: { record: () => Promise.reject(new Error('database unavailable')) },
    });
    const { payload } = await failureOf(buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx()));
    expect(payload).toMatchObject({
      code: 'model-invocation-failed',
      message:
        "Model call to anthropic (claude-haiku-4-5) failed: 529 overloaded (and the failed call couldn't be recorded: database unavailable)",
      cause: providerError,
    });
  });

  test('an aborted turn stays aborted when its failed call goes unrecorded', async () => {
    const t = turn({
      invoke: () => {
        t.ctx.turnAbort.abort();
        return Promise.reject(new Error('aborted'));
      },
      sink: { record: () => Promise.reject(new Error('database unavailable')) },
    });
    const { payload } = await failureOf(buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx()));
    expect(payload.code).toBe('agent-turn-aborted');
    expect(payload.message).toContain("couldn't be recorded: database unavailable");
  });

  test('a sink that fails and then records: the step goes on, the call recorded once', async () => {
    const recorded: ModelUsageRecord[] = [];
    let tries = 0;
    const t = turn({
      invoke: async () => ANSWER,
      sink: {
        record: async (call) => {
          tries += 1;
          if (tries === 1) throw new Error('connection reset');
          recorded.push(call);
        },
      },
    });
    await expect(buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx())).resolves.toBeDefined();
    expect(tries).toBe(2);
    expect(recorded).toHaveLength(1);
  });

  test('a fallback provider is recorded as one', async () => {
    const t = turn({ invoke: async () => ANSWER, fallback: true });
    await buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx());
    expect(t.recorded[0]?.fallback).toBe(true);
  });

  test("a sink that still can't record after its retries fails the step: the call isn't left unrecorded", async () => {
    const t = turn({
      invoke: async () => ANSWER,
      sink: {
        record: () => Promise.reject(new Error('database unavailable')),
      },
    });
    const { payload } = await failureOf(buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx()));
    expect(payload).toMatchObject({
      code: 'persistence-error',
      message: "The model call couldn't be recorded: database unavailable",
    });
  });

  test('a dry run spends nothing and records nothing; without a sink, nothing is recorded either', async () => {
    let called = 0;
    const dry = turn({
      invoke: async () => {
        called += 1;
        return ANSWER;
      },
    });
    await buildModelCallHandler(dry.ctx)({ nextMessages: [] }, kctx(true));
    expect(called).toBe(0);
    expect(dry.recorded).toEqual([]);

    const unsunk = turn({ invoke: async () => ANSWER, sink: 'none' });
    await expect(
      buildModelCallHandler(unsunk.ctx)({ nextMessages: [] }, kctx()),
    ).resolves.toBeDefined();
  });
});

describe("a call's thinking: the level the agent asked for, and the one its adapter sent", () => {
  const sentLow: ModelCallResult = {
    ...ANSWER,
    thinking: { level: 'low', sent: { 'output_config.effort': 'low' } },
  };

  test("the call asks for the model settings' level; the record, the node and the event keep what was asked and sent", async () => {
    let asked: unknown;
    const t = turn({
      invoke: async (input) => {
        asked = input.thinking;
        return sentLow;
      },
      modelSettings: { thinking: 'minimal', temperature: 0.2 },
    });
    await buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx());
    expect(asked).toBe('minimal');
    expect(t.recorded[0]?.thinkingAsked).toBe('minimal');
    expect(t.recorded[0]?.result?.thinking).toEqual(sentLow.thinking);
    expect(t.nodes[0]?.attributes?.thinking).toEqual({ asked: 'minimal', level: 'low' });
    expect(t.events.find((e) => e.kind === 'model.call.completed')?.thinking).toEqual({
      asked: 'minimal',
      level: 'low',
    });
  });

  test("none asked: the model's default, when its adapter sent one, is the level alone", async () => {
    const t = turn({ invoke: async () => sentLow });
    await buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx());
    expect(t.recorded[0]?.thinkingAsked).toBeUndefined();
    expect(t.nodes[0]?.attributes?.thinking).toEqual({ level: 'low' });
  });

  test('none asked and none sent: nothing about thinking anywhere', async () => {
    let asked: unknown = 'unset';
    const t = turn({
      invoke: async (input) => {
        asked = input.thinking;
        return ANSWER;
      },
    });
    await buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx());
    expect(asked).toBeUndefined();
    expect(t.recorded[0]).not.toHaveProperty('thinkingAsked');
    expect(t.nodes[0]?.attributes).not.toHaveProperty('thinking');
    expect(t.events.find((e) => e.kind === 'model.call.completed')).not.toHaveProperty('thinking');
  });

  test('a call that failed keeps the level it asked for', async () => {
    const t = turn({
      invoke: async () => {
        throw new Error('400 thinking level not supported');
      },
      modelSettings: { thinking: 'max' },
    });
    await failureOf(buildModelCallHandler(t.ctx)({ nextMessages: [] }, kctx()));
    expect(t.recorded[0]).toMatchObject({ status: 'failed', thinkingAsked: 'max' });
  });
});
