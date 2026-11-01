// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A gated call's approval reads in its tool's words (`approval`), filled
 * from the call's arguments. The words go in the approval's `context`,
 * behind sign-in; its `title` names only the tool, since the title goes
 * out in the reviewer's mail and the `approval.requested` event.
 */

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import { defineTool } from '@kindgi/tools';
import type { AnyTool, ToolApproval } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const ARGS = { orderId: 1043, amount: 25, reason: 'Zip broke\non day one' };

function refundTool(ran: unknown[], approval?: ToolApproval): AnyTool {
  const defined = defineTool<typeof ARGS, { ok: boolean }>({
    id: 'pack.refund' as ToolId,
    description: 'Refunds an order.',
    version: '1.0.0',
    input: {
      type: 'object',
      properties: {
        orderId: { type: 'integer' },
        amount: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['orderId', 'amount', 'reason'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    mutating: true,
    ...(approval !== undefined && { approval }),
    handler: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

/** One `pack.refund` call with `ARGS`, gated for every call, and approved. */
async function dispatchGated(tool: AnyTool) {
  const a = { id: 'pack.agent', version: '1.0.0' } as unknown as Agent;
  const enqueued: Record<string, unknown>[] = [];
  const ctx = {
    input: { tenantId: 't-1' as TenantId, projectId: 'p-1', conversationId: 'conv-1', agent: a },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { id: 'msg-1', ...m },
        }),
      },
      hitl: {
        enqueue: async (input: Record<string, unknown>) => {
          enqueued.push(input);
        },
      },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({
      tenant: { tools: { 'pack.refund': { mode: 'always_ask' } } },
      agent: a,
    }),
  } as unknown as TurnContext;
  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'pack.refund', arguments: ARGS }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [{ role: 'user', content: 'refund it' }] as readonly ModelMessage[],
    },
    testNodeContext({
      runId: 'run-1' as RunId,
      waitForToken: (async () => ({ decided: 'approve' })) as NodeContext['waitForToken'],
    }),
  );
  expect(enqueued).toHaveLength(1);
  return enqueued[0] as Record<string, unknown>;
}

const APPROVAL: ToolApproval = {
  title: 'Refund {amount} on order #{orderId}',
  summary: '{reason}',
  about: { kind: 'acme.order', id: '{orderId}' },
};

describe("a gated call's approval, in its tool's words", () => {
  test('the words go in its context, filled and on one line; its title names only the tool', async () => {
    const ran: unknown[] = [];
    const enqueued = await dispatchGated(refundTool(ran, APPROVAL));
    expect(enqueued.context).toEqual({
      text: { title: 'Refund 25 on order #1043', summary: 'Zip broke on day one' },
      about: { kind: 'acme.order', id: '1043' },
    });
    expect(enqueued.title).toBe('Approve a call to pack.refund');
    expect(`${enqueued.title as string} ${enqueued.description as string}`).not.toMatch(/1043|Zip/);
    expect(ran).toEqual([ARGS]);
  });

  test('a tool without one asks as before, with no context', async () => {
    const ran: unknown[] = [];
    const enqueued = await dispatchGated(refundTool(ran));
    expect(enqueued.title).toBe('Approve a call to pack.refund');
    expect(enqueued).not.toHaveProperty('context');
    expect(ran).toEqual([ARGS]);
  });

  test("arguments that don't fill it (a pack read from disk, unchecked) ask with the title alone", async () => {
    const ran: unknown[] = [];
    const unchecked = {
      ...refundTool(ran),
      approval: { title: 'Refund {total}' },
    } as unknown as AnyTool;
    const enqueued = await dispatchGated(unchecked);
    expect(enqueued.title).toBe('Approve a call to pack.refund');
    expect(enqueued).not.toHaveProperty('context');
    expect(ran).toEqual([ARGS]);
  });
});
