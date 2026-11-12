// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool that fails a call on purpose (`ToolFailure`) in an agent's turn:
 * its own `toolErrors` kind, `tool-failed`, out of the default; the
 * model's retry result carries the tool's code, words and details; a turn
 * it ends reads `tool-failed` at the top, not inside the call's error.
 */

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import { ToolFailure, defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, Semver, TenantId, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import {
  DEFAULT_TOOL_ERRORS,
  type ToolErrorPolicy,
  effectiveToolErrorPolicy,
  toolErrorKindOf,
} from '../src/handlers/tool-errors.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent, AgentId } from '../src/types.js';
import { testNodeContext } from './node-context.js';

function failingTool(details?: Record<string, unknown>): AnyTool {
  const defined = defineTool<{ orderId: string }, { found: boolean }>({
    id: 'acme.get-order' as ToolId,
    description: 'Looks an order up.',
    version: '1.0.0',
    input: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { found: { type: 'boolean' } },
      required: ['found'],
      additionalProperties: false,
    },
    effects: [],
    handler: async ({ orderId }) => {
      throw new ToolFailure(
        'order-not-found',
        `No order ${orderId}`,
        details === undefined ? {} : { details },
      );
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

function turn(tool: AnyTool, policy?: ToolErrorPolicy) {
  const events: Record<string, unknown>[] = [];
  const agent = { id: 'acme.agent', version: '1.0.0' } as unknown as Agent;
  const ctx = {
    input: { tenantId: 't-1' as TenantId, conversationId: 'conv-1', agent },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { id: 'msg-1', ...m },
        }),
      },
      onEvent: async (event: Record<string, unknown>) => {
        events.push(event);
      },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
    ...(policy !== undefined && { toolErrorPolicy: policy }),
    initialMessageCount: 1,
  } as unknown as TurnContext;
  const dispatch = (nextMessages: readonly ModelMessage[] = [{ role: 'user', content: 'Z-9?' }]) =>
    buildDispatchToolsHandler(ctx)(
      {
        step: 1,
        finishReason: 'tool-use',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-0', name: 'acme.get-order', arguments: { orderId: 'Z-9' } }],
        },
        iterationUsage: { promptTokens: 0, completionTokens: 0 },
        provider: { id: 'p', model: 'm' },
        nextMessages,
      },
      testNodeContext({ runId: 'run-1' as RunId }),
    ) as Promise<{ readonly nextMessages: readonly ModelMessage[] }>;
  return { dispatch, events };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    if (error instanceof AgentTurnFailure)
      return error.payload as unknown as Record<string, unknown>;
    throw error;
  }
  throw new Error('the turn did not fail');
}

const retrying = effectiveToolErrorPolicy({ retryOn: ['tool-failed'] }, undefined);

describe('the tool-failed kind', () => {
  test("is a call whose tool failed it on purpose, and isn't in the default", () => {
    expect(
      toolErrorKindOf({ code: 'tool-invocation-failed', cause: { code: 'tool-failed' } }),
    ).toBe('tool-failed');
    expect(DEFAULT_TOOL_ERRORS.retryOn).not.toContain('tool-failed');
  });

  test("a tenant's tool-errors policy can take it away", () => {
    const capped = effectiveToolErrorPolicy(
      { retryOn: ['tool-failed', 'invalid-arguments'] },
      { retryOn: ['invalid-arguments'] },
    );
    expect([...capped.retryOn]).toEqual(['invalid-arguments']);
  });

  test('an agent may name it in retryOn', () => {
    const r = defineAgent({
      id: 'acme.agent' as AgentId,
      version: '1.0.0' as Semver,
      name: 'Agent',
      instructions: 'Help.',
      capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
      tools: [],
      retrieval: [],
      guardrails: [],
      toolErrors: { retryOn: ['tool-failed'] },
    });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
    expect(r.value.toolErrors).toEqual({ retryOn: ['tool-failed'] });
  });
});

describe('dispatch-tools — a tool that fails a call on purpose', () => {
  test("by default ends the turn as tool-failed, with the tool's code, words and details at the top", async () => {
    const payload = await failure(turn(failingTool({ orderId: 'Z-9' })).dispatch());
    expect(payload).toStrictEqual({
      code: 'tool-failed',
      message: 'No order Z-9',
      toolId: 'acme.get-order',
      reason: 'order-not-found',
      details: { orderId: 'Z-9' },
    });
  });

  test('has no details at the top when the tool gave none', async () => {
    const payload = await failure(turn(failingTool()).dispatch());
    expect(payload).toStrictEqual({
      code: 'tool-failed',
      message: 'No order Z-9',
      toolId: 'acme.get-order',
      reason: 'order-not-found',
    });
  });

  test("with tool-failed in retryOn, goes back to the model with the tool's code, words and details", async () => {
    const out = await turn(failingTool({ orderId: 'Z-9' }), retrying).dispatch();
    expect(JSON.parse(out.nextMessages.at(-1)?.content ?? '{}')).toStrictEqual({
      kindgi: 'tool-error-retry',
      status: 'failed',
      error: {
        kind: 'tool-failed',
        message: 'No order Z-9',
        reason: 'order-not-found',
        details: { orderId: 'Z-9' },
      },
      instruction:
        'The tool said this call failed, and why. Tell the person, or try another way; the same call gives the same answer.',
    });
  });

  test('past the retries the turn fails as tool-failed, with the retries it took', async () => {
    const { dispatch } = turn(failingTool(), retrying);
    const first = await dispatch();
    const payload = await failure(dispatch(first.nextMessages));
    expect(payload).toMatchObject({
      code: 'tool-failed',
      reason: 'order-not-found',
      toolRetries: 1,
    });
    expect(payload).not.toHaveProperty('cause');
  });

  test("its tool.failed event says tool-failed with the tool's code, and leaves its details out", async () => {
    const { dispatch, events } = turn(failingTool({ lookedIn: 'archive-2025' }));
    await failure(dispatch());
    const failed = events.find((e) => e.kind === 'tool.failed');
    expect(failed).toMatchObject({ toolId: 'acme.get-order', invocationId: 'call-0' });
    expect(failed?.error).toStrictEqual({
      code: 'tool-failed',
      message: 'No order Z-9',
      reason: 'order-not-found',
    });
    expect(JSON.stringify(events)).not.toContain('archive-2025');
  });
});
