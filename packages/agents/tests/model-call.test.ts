// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The model-call step when the provider throws: the turn fails with the
 * provider's own words in its message (a bad key's 401, a 429), not only
 * in `cause`, since callers show the message.
 */

import { describe, expect, test } from 'vitest';

import type { ModelInfo, ModelProvider, ProviderMetadata } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { ProjectId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { buildModelCallHandler } from '../src/handlers/model-call.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { ConversationId } from '../src/types.js';

const MODEL = { name: 'claude-haiku-4-5' } as ModelInfo;

function contextFailingWith(cause: unknown): TurnContext {
  const agent = defineAgent({
    id: 'acme.helper',
    version: '1.0.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (agent.kind === 'err') throw new Error(JSON.stringify(agent.error.issues));
  const provider: ModelProvider = {
    metadata: { id: 'anthropic' } as ProviderMetadata,
    invoke: () => Promise.reject(cause),
  };
  return {
    input: {
      tenantId: 'acme' as TenantId,
      projectId: '00000000-0000-0000-0000-0000000000aa' as ProjectId,
      agent: agent.value,
      conversationId: '00000000-0000-0000-0000-0000000000cc' as ConversationId,
      userMessage: 'hi',
    },
    bindings: {} as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
    provider,
    model: MODEL,
    tools: { definitions: [], byName: new Map() },
  };
}

async function failure(ctx: TurnContext): Promise<AgentTurnFailure> {
  const run = buildModelCallHandler(ctx)({ nextMessages: [] }, {
    dryRun: false,
  } as NodeContext);
  const thrown = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(AgentTurnFailure);
  return thrown as AgentTurnFailure;
}

describe('model-call: the provider throws', () => {
  test("the message names the provider and model and carries the provider's words", async () => {
    const cause = new Error(
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    );
    const { payload } = await failure(contextFailingWith(cause));
    expect(payload).toEqual({
      code: 'model-invocation-failed',
      message:
        'Model call to anthropic (claude-haiku-4-5) failed: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      cause,
    });
  });

  test('a multi-line or very long cause becomes one line of at most 500 characters', async () => {
    const lines = await failure(contextFailingWith(new Error('rate limited\n  retry after 30s')));
    expect(lines.payload.message).toBe(
      'Model call to anthropic (claude-haiku-4-5) failed: rate limited retry after 30s',
    );

    const long = await failure(contextFailingWith(new Error('x'.repeat(2000))));
    const detail = long.payload.message.split('failed: ')[1] ?? '';
    expect(detail).toHaveLength(500);
    expect(detail.endsWith('…')).toBe(true);
  });

  test('a non-Error or an empty message still says something', async () => {
    const thrownString = await failure(contextFailingWith('socket hang up'));
    expect(thrownString.payload.message).toBe(
      'Model call to anthropic (claude-haiku-4-5) failed: socket hang up',
    );
    const empty = await failure(contextFailingWith(new TypeError('')));
    expect(empty.payload.message).toBe(
      'Model call to anthropic (claude-haiku-4-5) failed: TypeError',
    );
  });

  test('an aborted turn is still agent-turn-aborted', async () => {
    const ctx = contextFailingWith(new Error('The operation was aborted.'));
    ctx.turnAbort.abort();
    const { payload } = await failure(ctx);
    expect(payload.code).toBe('agent-turn-aborted');
  });
});
