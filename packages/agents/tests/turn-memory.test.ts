// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn's memory is charged by size before each model call: (4 + n) × the
 * conversation as sent, n the iterations done, replacing the turn's last
 * charge. Refused, the turn fails with `turn-memory-limit-reached` before
 * the model is called, naming the limit. With no binding, or in a dry
 * run, nothing is charged.
 */

import { describe, expect, test } from 'vitest';

import type {
  ModelCallResult,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  ProviderMetadata,
} from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildModelCallHandler } from '../src/handlers/model-call.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import {
  type TurnMemoryBinding,
  type TurnMemoryCharge,
  turnMemoryBytes,
} from '../src/handlers/turn-memory.js';
import type { ConversationId } from '../src/types.js';

const ANSWER: ModelCallResult = {
  message: { role: 'assistant', content: 'done' },
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 2 },
  costUsd: 0,
  durationMs: 5,
  provider: { id: 'anthropic', model: 'claude-haiku-4-5' },
};

const MIB = 1024 * 1024;

/** A turn whose binding answers with `answer` and logs every charge and call, in order. */
function turn(options: {
  readonly answer?: (bytes: number) => TurnMemoryCharge;
  readonly bound?: boolean;
  readonly steps?: number;
}) {
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
  const log: string[] = [];
  const charges: number[] = [];
  const runs: string[] = [];
  const events: string[] = [];
  const turnMemory: TurnMemoryBinding = {
    charge: async (bytes, turn) => {
      charges.push(bytes);
      runs.push(turn.runId);
      log.push('charge');
      return options.answer?.(bytes) ?? { ok: true };
    },
  };
  const invoke: ModelProvider['invoke'] = async () => {
    log.push('model');
    return ANSWER;
  };
  const ctx = {
    input: {
      tenantId: 'acme' as TenantId,
      projectId: '00000000-0000-0000-0000-0000000000aa' as ProjectId,
      agent: agent.value,
      conversationId: '00000000-0000-0000-0000-0000000000cc' as ConversationId,
      userMessage: 'hi',
    },
    bindings: {
      ...(options.bound !== false && { turnMemory }),
      onEvent: async (event: { kind: string }) => {
        events.push(event.kind);
      },
    } as unknown as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: options.steps ?? 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
    provider: { metadata: { id: 'anthropic' } as ProviderMetadata, invoke },
    model: { name: 'claude-haiku-4-5' } as ModelInfo,
    tools: { definitions: [], byName: new Map() },
    userMessage: { sequence: 1 },
  } as unknown as TurnContext;
  return { ctx, log, charges, runs, events };
}

const kctx = (dryRun = false) =>
  ({ runId: 'run-1' as RunId, nodeId: 'model-call' as NodeId, dryRun }) as unknown as NodeContext;

const conversation = (text: string): ModelMessage[] => [
  { role: 'system', content: 'Help.' },
  { role: 'user', content: text },
];
const sizeOf = (messages: readonly ModelMessage[]) =>
  Buffer.byteLength(JSON.stringify(messages), 'utf8');

describe('turn memory: charged by size before each model call', () => {
  test('(4 + n) × the conversation as sent, before the model, each call replacing the last', async () => {
    const t = turn({});
    const call = buildModelCallHandler(t.ctx);
    const first = conversation('hi');
    const second = [
      ...first,
      { role: 'assistant', content: 'a much longer answer' } as ModelMessage,
    ];
    await call({ nextMessages: first }, kctx());
    await call({ nextMessages: second }, kctx());
    expect(t.charges).toEqual([4 * sizeOf(first), 5 * sizeOf(second)]);
    // The turn's own run, for the runtime's record of a refusal.
    expect(t.runs).toEqual(['run-1', 'run-1']);
    expect(t.log).toEqual(['charge', 'model', 'charge', 'model']);
  });

  test('a resumed turn counts the iterations it had already done', async () => {
    const t = turn({ steps: 3 });
    const messages = conversation('hi');
    await buildModelCallHandler(t.ctx)({ nextMessages: messages }, kctx());
    expect(t.charges).toEqual([7 * sizeOf(messages)]);
  });

  test('the conversation is measured in UTF-8 bytes, not characters', () => {
    const plain = conversation('aaaa');
    const accented = conversation('éééé');
    expect(turnMemoryBytes(accented, 0) - turnMemoryBytes(plain, 0)).toBe(4 * 4);
  });

  test.each([
    ['tenant', "the tenant's share of"],
    ['server', "the runtime's"],
  ] as const)(
    'refused at the %s limit: the turn fails naming it, and the model is never called',
    async (limit, whose) => {
      const t = turn({
        answer: () => ({ ok: false, limit, heldBytes: 190 * MIB, limitBytes: 192 * MIB }),
      });
      const thrown = await buildModelCallHandler(t.ctx)(
        { nextMessages: conversation('hi') },
        kctx(),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(AgentTurnFailure);
      expect((thrown as AgentTurnFailure).payload).toEqual({
        code: 'turn-memory-limit-reached',
        message: `The turn needs more memory than ${whose} turn memory has left (190.0 of 192.0 MiB held). Retry later, or use a smaller conversation.`,
        limit,
        heldBytes: 190 * MIB,
        limitBytes: 192 * MIB,
      });
      expect(t.log).toEqual(['charge']);
      expect(t.events).not.toContain('model.call.started');
      expect(t.ctx.usage.steps).toBe(0);
    },
  );

  test('no binding: nothing is charged, and the model is called', async () => {
    const t = turn({ bound: false });
    await buildModelCallHandler(t.ctx)({ nextMessages: conversation('hi') }, kctx());
    expect(t.charges).toEqual([]);
    expect(t.ctx.usage.steps).toBe(1);
  });

  test('a dry run holds nothing: no charge', async () => {
    const t = turn({ answer: () => ({ ok: false, limit: 'server', heldBytes: 1, limitBytes: 1 }) });
    await buildModelCallHandler(t.ctx)({ nextMessages: conversation('hi') }, kctx(true));
    expect(t.charges).toEqual([]);
  });
});
