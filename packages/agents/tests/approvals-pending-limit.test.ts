// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A gate that asks for an approval past the tenant's limit on approvals
 * waiting: the HITL binding's `enqueue` refuses it (an error with
 * `code: 'approvals-pending-limit'`), and the step fails naming the limit.
 * It never waits on an approval nobody can see. Any other enqueue failure
 * stays soft: the gate still waits.
 */

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { ConversationId, RunId, TenantId, ToolId } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure, approvalsPendingLimitOf } from '../src/handlers/errors.js';
import { buildSetupHandler } from '../src/handlers/setup.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const refusal = () =>
  Object.assign(
    new Error("This tenant's limit on approvals waiting for a decision (3) is reached."),
    { code: 'approvals-pending-limit', approvalsPending: 3 },
  );

function agent(conversationPolicy: Record<string, unknown>): Agent {
  return {
    id: 'pack.agent',
    version: '1.0.0',
    name: 'Pack agent',
    conversationPolicy,
  } as unknown as Agent;
}

function lookupTool(ran: unknown[]): AnyTool {
  const defined = defineTool<{ q: string }, { ok: boolean }>({
    id: 'pack.lookup' as ToolId,
    description: 'Looks something up.',
    version: '1.0.0',
    input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    handler: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

/** One gated `pack.lookup` call whose approval `enqueue` answers; approvals are granted. */
async function gatedCall(enqueue: () => Promise<void>) {
  const ran: unknown[] = [];
  const waits: string[] = [];
  const tool = lookupTool(ran);
  const a = agent({ hitl: { tools: { overrides: { 'pack.lookup': 'always_ask' } } } });
  const ctx = {
    input: { tenantId: 't-1' as TenantId, projectId: 'p-1', conversationId: 'conv-1', agent: a },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { id: 'msg-1', ...m },
        }),
      },
      hitl: { enqueue },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent: a }),
  } as unknown as TurnContext;
  const outcome = await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'pack.lookup', arguments: { q: 'x' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [{ role: 'user', content: 'look it up' }] as readonly ModelMessage[],
    },
    testNodeContext({
      runId: 'run-1' as RunId,
      waitForToken: (async (tokenId: string) => {
        waits.push(tokenId);
        return { decided: 'approve' };
      }) as NodeContext['waitForToken'],
    }),
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { ran, waits, outcome };
}

/** The turn's setup, at a conversation past its `afterTurns`, whose approval `enqueue` answers. */
async function sessionGate(enqueue: () => Promise<void>) {
  const waits: string[] = [];
  const a = agent({ hitl: { afterTurns: 2 } });
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      projectId: 'p-1',
      conversationId: 'conv-1' as ConversationId,
      agent: a,
    },
    bindings: {
      runSnapshotBinding: { write: async () => ({ kind: 'ok', value: undefined }) },
      conversationBinding: {
        getConversation: async () => ({
          kind: 'ok',
          value: { id: 'conv-1', agentId: a.id, agentVersion: a.version, turnCount: 3 },
        }),
      },
      hitl: { enqueue },
    },
  } as unknown as TurnContext;
  const outcome = await buildSetupHandler(ctx)(
    {},
    testNodeContext({
      runId: 'run-2' as RunId,
      waitForToken: (async (tokenId: string) => {
        waits.push(tokenId);
        throw new Error('parked');
      }) as NodeContext['waitForToken'],
    }),
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { waits, outcome };
}

describe('a tool gate past the tenant’s limit on approvals waiting', () => {
  test('the step fails with approvals-pending-limit, naming it; nothing waits and nothing runs', async () => {
    const { ran, waits, outcome } = await gatedCall(async () => {
      throw refusal();
    });
    expect(outcome).toBeInstanceOf(AgentTurnFailure);
    expect((outcome as AgentTurnFailure).payload).toEqual({
      code: 'approvals-pending-limit',
      message: "This tenant's limit on approvals waiting for a decision (3) is reached.",
      approvalsPending: 3,
    });
    expect(waits).toEqual([]);
    expect(ran).toEqual([]);
  });

  test('any other enqueue failure stays soft: the gate waits, and on approve the tool runs', async () => {
    const { ran, waits, outcome } = await gatedCall(async () => {
      throw new Error('the approvals store is down');
    });
    expect(outcome).toBeUndefined();
    expect(waits).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });
});

describe('a session gate past the tenant’s limit on approvals waiting', () => {
  test('the turn fails with approvals-pending-limit; it never parks', async () => {
    const { waits, outcome } = await sessionGate(async () => {
      throw refusal();
    });
    expect((outcome as AgentTurnFailure).payload).toMatchObject({
      code: 'approvals-pending-limit',
      approvalsPending: 3,
    });
    expect(waits).toEqual([]);
  });

  test('any other enqueue failure stays soft: the turn still parks', async () => {
    const { waits, outcome } = await sessionGate(async () => {
      throw new Error('the approvals store is down');
    });
    expect(waits).toHaveLength(1);
    expect((outcome as Error).message).toBe('parked');
  });
});

describe('approvalsPendingLimitOf', () => {
  test('reads the code, the message and the limit; anything else is not a refusal', () => {
    expect(approvalsPendingLimitOf(refusal())).toMatchObject({ approvalsPending: 3 });
    expect(approvalsPendingLimitOf({ code: 'approvals-pending-limit' })).toEqual({
      code: 'approvals-pending-limit',
      message: "This tenant's limit on approvals waiting for a decision is reached.",
    });
    expect(approvalsPendingLimitOf(new Error('other'))).toBeUndefined();
    expect(approvalsPendingLimitOf('approvals-pending-limit')).toBeUndefined();
    expect(approvalsPendingLimitOf(null)).toBeUndefined();
  });
});
