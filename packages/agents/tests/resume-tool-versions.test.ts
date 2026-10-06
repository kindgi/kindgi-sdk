// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A resumed turn runs the tool versions its `setup` resolved, not its
 * ranges resolved again: a version published while the turn waited (on
 * an approval) doesn't run mid-turn, and one that's gone fails the turn
 * rather than running another. A journal from before `setup` recorded
 * the versions resolves the ranges, as it did.
 */

import { describe, expect, test } from 'vitest';

import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelProvider } from '@kindgi/capabilities';
import type { JournalEntry } from '@kindgi/runtime';
import { createToolRegistry, defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { Semver, TenantId, Timestamp, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { rehydrateTurnContext } from '../src/handlers/rehydrate.js';
import type { Agent, AgentId } from '../src/types.js';

const tenantId = 't-1' as TenantId;
const AT = '2026-10-05T00:00:00Z' as Timestamp;

function lookup(version: string): AnyTool {
  const defined = defineTool<{ q: string }, { found: string }>({
    id: 'pack.lookup' as ToolId,
    description: 'Looks something up.',
    version,
    input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    output: {
      type: 'object',
      properties: { found: { type: 'string' } },
      required: ['found'],
      additionalProperties: false,
    },
    effects: [],
    handler: async (input) => ({ found: input.q }),
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

function agent(): Agent {
  const r = defineAgent({
    id: 'pack.agent' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Agent',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [{ id: 'pack.lookup', version: '^1.0.0' }],
    retrieval: [],
    guardrails: [],
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

const provider: ModelProvider = {
  metadata: {
    id: 'p',
    region: 'unspecified',
    models: [
      {
        name: 'p-model',
        contextWindow: 128_000,
        features: ['tool-use'],
        cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
      },
    ],
  },
  invoke: (async () => ({})) as unknown as ModelProvider['invoke'],
};

/** A turn being resumed, with the tool versions the registry now holds. */
function resumedTurn(registered: readonly string[]): TurnContext {
  const a = agent();
  return {
    input: { tenantId, conversationId: 'conv-1', agent: a },
    bindings: {
      conversationBinding: {
        getConversation: async () => ({
          kind: 'ok',
          value: { id: 'conv-1', agentId: a.id, agentVersion: a.version, turnCount: 1 },
        }),
        readMessages: async () => ({ kind: 'ok', value: [] }),
      },
      toolRegistry: createToolRegistry(registered.map(lookup)),
      providerRegistry: createProviderRegistry([{ tenantId, provider }]).registry,
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnContext;
}

/** A journal whose `setup` completed with this output. */
const journal = (setupOutput: Record<string, unknown>): readonly JournalEntry[] => [
  {
    sequence: 1,
    kind: 'step.completed',
    nodeId: 'setup',
    payload: { output: setupOutput },
    timestamp: AT,
  } as unknown as JournalEntry,
];

const route = { turnNumber: 2, providerId: 'p', providerModel: 'p-model', toolCount: 1 };

describe('a resumed turn and its tool versions', () => {
  test('runs the version setup resolved, though a newer one in range was published meanwhile', async () => {
    const ctx = resumedTurn(['1.0.0', '1.1.0']);
    await rehydrateTurnContext(
      ctx,
      'run-1',
      journal({ ...route, toolVersions: { 'pack.lookup': '1.0.0' } }),
    );
    expect(ctx.tools?.byName.get('pack.lookup')).toMatchObject({
      resolvedVersion: '1.0.0',
      requestedRange: '^1.0.0',
    });
  });

  test("a version that's gone fails the turn; it doesn't run another mid-turn", async () => {
    const ctx = resumedTurn(['1.1.0']);
    let failure: unknown;
    try {
      await rehydrateTurnContext(
        ctx,
        'run-1',
        journal({ ...route, toolVersions: { 'pack.lookup': '1.0.0' } }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgentTurnFailure);
    expect((failure as AgentTurnFailure).payload).toMatchObject({
      code: 'tool-version-unresolvable',
      toolId: 'pack.lookup',
      message: expect.stringContaining('this turn started with version 1.0.0'),
    });
  });

  test('a journal from before setup recorded the versions resolves the ranges, as it did', async () => {
    const ctx = resumedTurn(['1.0.0', '1.1.0']);
    await rehydrateTurnContext(ctx, 'run-1', journal(route));
    expect(ctx.tools?.byName.get('pack.lookup')?.resolvedVersion).toBe('1.1.0');
  });
});
