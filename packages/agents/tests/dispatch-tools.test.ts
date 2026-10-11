// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeContext } from '@kindgi/handler';
import { defineTool, toolIdempotencyKey } from '@kindgi/tools';
import type { AnyTool, ToolContext } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

/**
 * Run one model tool call through dispatch-tools and return the context the
 * tool saw. `input` adds to the turn's input; `args` are the model's arguments.
 */
async function contextSeen(
  input: Record<string, unknown>,
  args: Record<string, unknown> = { q: 'x' },
  records: Map<string, unknown> = new Map(),
  step: Partial<NodeContext> = {},
): Promise<ToolContext | undefined> {
  let seen: ToolContext | undefined;
  const defined = defineTool<Record<string, unknown>, { ok: boolean }>({
    id: 'pack.probe' as ToolId,
    description: 'Records its context.',
    version: '1.0.0',
    input: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        projectId: { type: 'string' },
        orgId: { type: 'string' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    handler: async (_input, ctx) => {
      seen = ctx;
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  const tool = defined.value as unknown as AnyTool;

  let seq = 0;
  const agent = { id: 'pack.agent', version: '1.0.0' } as unknown as Agent;
  const ctx = {
    input: { tenantId: 't-1' as TenantId, conversationId: 'conv-1', agent, ...input },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { id: `msg-${++seq}`, ...m },
        }),
      },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
  } as unknown as TurnContext;

  const handler = buildDispatchToolsHandler(ctx);
  await handler(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-7', name: 'pack.probe', arguments: args }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
    },
    testNodeContext({ runId: 'run-42' as RunId, ...step }, records),
  );
  return seen;
}

describe('dispatch-tools — the context a tool receives', () => {
  test('runId is the kernel run; requestId is the model call', async () => {
    const seen = await contextSeen({ projectId: 'project-1' });
    expect(seen?.runId).toBe('run-42');
    expect(seen?.requestId).toBe('call-7');
    expect(seen?.tenantId).toBe('t-1');
  });

  test("the run's project and org, never the model's arguments", async () => {
    const seen = await contextSeen(
      { projectId: 'project-1', orgId: 'org-1' },
      { q: 'x', projectId: 'project-other', orgId: 'org-other' },
    );
    expect(seen?.projectId).toBe('project-1');
    expect(seen?.orgId).toBe('org-1');
  });

  test('a project without an org: no orgId', async () => {
    const seen = await contextSeen({ projectId: 'project-1' });
    expect(seen?.projectId).toBe('project-1');
    expect(seen).not.toHaveProperty('orgId');
  });
});

describe("dispatch-tools — a call's idempotency key", () => {
  const ITERATION_2 = 'agent-loop#2/dispatch-tools';

  test("made from the run, the step's scope, the tool and the model's call id", async () => {
    const seen = await contextSeen({ projectId: 'project-1' }, { q: 'x' }, new Map(), {
      stepScope: ITERATION_2,
    });
    expect(seen?.idempotencyKey).toBe(
      toolIdempotencyKey({
        runId: 'run-42',
        stepScope: ITERATION_2,
        toolId: 'pack.probe',
        callId: 'call-7',
      }),
    );
  });

  test('the same when the step runs again; another loop iteration with the same call id gets another', async () => {
    const at = (stepScope: string) =>
      contextSeen({ projectId: 'project-1' }, { q: 'x' }, new Map(), { stepScope });
    const first = await at(ITERATION_2);
    const again = await at(ITERATION_2);
    const next = await at('agent-loop#3/dispatch-tools');
    expect(again?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(next?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  test("a host that doesn't name its steps: no key", async () => {
    const seen = await contextSeen({ projectId: 'project-1' });
    expect(seen).not.toHaveProperty('idempotencyKey');
  });
});

describe("dispatch-tools — a call's durable decisions (ctx.record)", () => {
  test("journals under the call and the tool, in the step's own record", async () => {
    const records = new Map<string, unknown>();
    const seen = await contextSeen({ projectId: 'project-1' }, { q: 'x' }, records);
    const env = await seen?.record?.('env', () => ({ ACME_REGION: 'eu' }));
    expect(env).toEqual({ ACME_REGION: 'eu' });
    expect([...records.keys()]).toEqual(['tool-call:call-7:pack.probe:env']);
  });

  test('when the step runs again, the call reads its decision back', async () => {
    const records = new Map<string, unknown>();
    const first = await contextSeen({ projectId: 'project-1' }, { q: 'x' }, records);
    await first?.record?.('env', () => ({ ACME_REGION: 'eu' }));
    const again = await contextSeen({ projectId: 'project-1' }, { q: 'x' }, records);
    let decided = false;
    const env = await again?.record?.('env', () => {
      decided = true;
      return { ACME_REGION: 'us' };
    });
    expect(env).toEqual({ ACME_REGION: 'eu' });
    expect(decided).toBe(false);
  });
});
