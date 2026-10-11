// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `InvokeAgentBindings.authorizeToolCall`: asked before each of a turn's
 * tool calls. A denied call runs nothing and its result tells the model;
 * an allowed one runs; the decision is recorded with the call, so the
 * step run again keeps it.
 */

import type { Principal } from '@kindgi/authz';
import type { NodeContext } from '@kindgi/handler';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import type { InvokeAgentBindings, ToolCallAuthorization } from '../src/handlers/public-types.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

type AuthorizeInput = Parameters<NonNullable<InvokeAgentBindings['authorizeToolCall']>>[0];

const PRINCIPAL = {
  actor: { kind: 'user', id: 'user-1', tenantId: 't-1' },
} as unknown as Principal;

/** One model tool call through dispatch-tools: whether the tool ran, what was appended, what was asked. */
async function dispatch(
  decide: ((input: AuthorizeInput) => Promise<ToolCallAuthorization>) | undefined,
  records: Map<string, unknown> = new Map(),
  step: Partial<NodeContext> = {},
) {
  let ran = 0;
  const asked: AuthorizeInput[] = [];
  const appended: Record<string, unknown>[] = [];
  const defined = defineTool<Record<string, unknown>, { ok: boolean }>({
    id: 'pack.refund' as ToolId,
    description: 'Refunds an order.',
    version: '1.0.0',
    input: { type: 'object', additionalProperties: true },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    mutating: false,
    handler: async () => {
      ran += 1;
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  const tool = defined.value as unknown as AnyTool;

  let seq = 0;
  const agent = { id: 'pack.agent', version: '1.0.0' } as unknown as Agent;
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      projectId: 'project-1',
      conversationId: 'conv-1',
      agent,
      principal: PRINCIPAL,
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          appended.push(m);
          return { kind: 'ok', value: { id: `msg-${++seq}`, ...m } };
        },
      },
      ...(decide !== undefined && {
        authorizeToolCall: async (input: AuthorizeInput) => {
          asked.push(input);
          return decide(input);
        },
      }),
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
  } as unknown as TurnContext;

  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-9', name: 'pack.refund', arguments: { orderId: '1042' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
    },
    testNodeContext({ runId: 'run-42' as RunId, ...step }, records),
  );
  return { ran: () => ran, asked, appended, records };
}

describe('authorizeToolCall', () => {
  test("is asked with the turn's tenant, project, principal and the tool", async () => {
    const { asked } = await dispatch(async () => ({ allowed: true }));
    expect(asked).toEqual([
      { tenantId: 't-1', projectId: 'project-1', principal: PRINCIPAL, toolId: 'pack.refund' },
    ]);
  });

  test('a denied call runs nothing; its result tells the model why, and the turn goes on', async () => {
    const { ran, appended } = await dispatch(async () => ({
      allowed: false,
      reason: 'user:user-1 does not have can_invoke on tool:pack.refund',
    }));
    expect(ran()).toBe(0);
    const result = JSON.stringify(appended);
    expect(result).toContain('"status":"denied"');
    expect(result).toContain('does not have can_invoke on tool:pack.refund');
  });

  test('an allowed call runs', async () => {
    const { ran } = await dispatch(async () => ({ allowed: true }));
    expect(ran()).toBe(1);
  });

  test('the decision is recorded with the call; the step run again reads it, not the binding', async () => {
    const records = new Map<string, unknown>();
    await dispatch(async () => ({ allowed: false, reason: 'not yet' }), records);
    expect([...records.keys()]).toContain('tool-call:call-9:pack.refund:kindgi.authorize');
    const again = await dispatch(async () => ({ allowed: true }), records);
    expect(again.asked).toEqual([]);
    expect(again.ran()).toBe(0);
  });

  test('absent: every call runs, and nothing is recorded for it', async () => {
    const { ran, records } = await dispatch(undefined);
    expect(ran()).toBe(1);
    expect([...records.keys()].some((k) => k.endsWith(':kindgi.authorize'))).toBe(false);
  });
});
