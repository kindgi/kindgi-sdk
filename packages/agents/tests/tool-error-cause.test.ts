// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool's throw, through a turn: its causes are said wherever the failure
 * shows (the run's failure message, the `tool.failed` event, the model's
 * retry result, the conversation), masked, with no part of a token or a
 * secret query value left.
 */

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import {
  AgentTurnFailure,
  type InvokeAgentError,
  turnFailureMessage,
} from '../src/handlers/errors.js';
import { type ToolErrorPolicy, effectiveToolErrorPolicy } from '../src/handlers/tool-errors.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { TurnEvent } from '../src/streaming.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

/** What a fetch through undici rejects with, its cause carrying the canary. */
function canaryThrow(): TypeError {
  return new TypeError('fetch failed', {
    cause: new Error(
      'request to https://shop.acme.example/orders?token=canary-q-0123456789&page=2 failed: Bearer canary-b-0123456789abcdef rejected; retry with kgi_bt_canary0123456789abcdWXYZ',
    ),
  });
}

function throwingTool(): AnyTool {
  const defined = defineTool<{ q: string }, { ok: boolean }>({
    id: 'acme.list-orders' as ToolId,
    description: 'Lists orders.',
    version: '1.0.0',
    input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    effects: [],
    handler: async () => {
      throw canaryThrow();
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

function turn(tool: AnyTool, policy?: ToolErrorPolicy) {
  const events: TurnEvent[] = [];
  const persisted: Record<string, unknown>[] = [];
  const agent = { id: 'acme.agent', version: '1.0.0' } as unknown as Agent;
  const ctx = {
    input: { tenantId: 't-1' as TenantId, conversationId: 'conv-1', agent },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          persisted.push(m);
          return { kind: 'ok', value: { id: `msg-${persisted.length}`, ...m } };
        },
      },
      onEvent: (e: TurnEvent) => {
        events.push(e);
      },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    initialMessageCount: 1,
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
    ...(policy !== undefined && { toolErrorPolicy: policy }),
  } as unknown as TurnContext;
  const dispatch = () =>
    buildDispatchToolsHandler(ctx)(
      {
        step: 1,
        finishReason: 'tool-use',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-0', name: 'acme.list-orders', arguments: { q: 'x' } }],
        },
        iterationUsage: { promptTokens: 0, completionTokens: 0 },
        provider: { id: 'p', model: 'm' },
        nextMessages: [{ role: 'user', content: 'list my orders' }] as readonly ModelMessage[],
      },
      testNodeContext({ runId: 'run-1' as RunId }),
    ) as Promise<{ readonly nextMessages: readonly ModelMessage[] }>;
  return { dispatch, events, persisted };
}

const SAID =
  'fetch failed; caused by Error: request to https://shop.acme.example/orders?token=[redacted]&page=2 failed: Bearer [redacted] rejected; retry with [redacted]';

/** No part of either token or the secret query value: not the canary, not the last four. */
function expectNoCanary(surface: string, text: string): void {
  for (const part of ['canary', 'WXYZ', 'kgi_bt_', '0123456789']) {
    expect(text, `${surface} holds ${part}`).not.toContain(part);
  }
}

describe("a tool's throw through a turn", () => {
  test("the run's failure message and the tool.failed event say the cause, masked", async () => {
    const { dispatch, events, persisted } = turn(throwingTool());
    let failure: AgentTurnFailure | undefined;
    try {
      await dispatch();
    } catch (error) {
      if (!(error instanceof AgentTurnFailure)) throw error;
      failure = error;
    }
    if (failure === undefined) throw new Error('the turn did not fail');

    const failureMessage = turnFailureMessage(failure.payload as unknown as InvokeAgentError);
    // The run writes it as JSON: the error and its cause, each with the message.
    const written = JSON.parse(failureMessage) as {
      readonly error: { readonly message: string; readonly cause: { readonly message: string } };
    };
    expect(written.error.message).toBe(`Tool "acme.list-orders" handler threw: ${SAID}`);
    expect(written.error.cause.message).toBe(`Tool "acme.list-orders" handler threw: ${SAID}`);
    expectNoCanary('the failure message', failureMessage);
    expectNoCanary("the failure's own message", failure.message);

    const failed = events.find((e) => e.kind === 'tool.failed') as
      | { readonly error: { readonly message: string } }
      | undefined;
    expect(failed?.error.message).toBe(`Tool "acme.list-orders" handler threw: ${SAID}`);
    expectNoCanary('the events', JSON.stringify(events));
    expectNoCanary('the conversation', JSON.stringify(persisted));
  });

  test("with a retry allowed, the model's retry result says it the same way", async () => {
    const { dispatch, events, persisted } = turn(
      throwingTool(),
      effectiveToolErrorPolicy({ retryOn: ['tool-error'] }, undefined),
    );
    const out = await dispatch();
    const result = out.nextMessages.at(-1)?.content ?? '';
    expect(JSON.parse(result)).toMatchObject({
      error: { kind: 'tool-error', message: `Tool "acme.list-orders" handler threw: ${SAID}` },
    });
    expectNoCanary("the model's retry result", result);
    expectNoCanary('the events', JSON.stringify(events));
    expectNoCanary('the conversation', JSON.stringify(persisted));
  });
});
