// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineTool } from '@kindgi/tools';
import type { AnyTool, ToolContext } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

describe('dispatch-tools — the context a tool receives', () => {
  test('runId is the kernel run; requestId is the model call', async () => {
    let seen: ToolContext | undefined;
    const defined = defineTool<{ q: string }, { ok: boolean }>({
      id: 'pack.probe' as ToolId,
      description: 'Records its context.',
      version: '1.0.0',
      input: {
        type: 'object',
        properties: { q: { type: 'string' } },
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
      input: { tenantId: 't-1' as TenantId, conversationId: 'conv-1', agent },
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
          toolCalls: [{ id: 'call-7', name: 'pack.probe', arguments: { q: 'x' } }],
        },
        iterationUsage: { promptTokens: 0, completionTokens: 0 },
        provider: { id: 'p', model: 'm' },
        nextMessages: [],
      },
      testNodeContext({ runId: 'run-42' as RunId }),
    );

    expect(seen?.runId).toBe('run-42');
    expect(seen?.requestId).toBe('call-7');
    expect(seen?.tenantId).toBe('t-1');
  });
});
