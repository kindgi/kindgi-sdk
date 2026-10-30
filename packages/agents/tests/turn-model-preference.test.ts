// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The model a turn prefers comes from one place: its model-settings
 * block's `providerId` and `model` when the block names one (a replay's
 * override included, which is how an improvement pass tries another
 * model), else the agent version's `preferredProvider` and
 * `preferredModel`.
 */

import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelProvider } from '@kindgi/capabilities';
import { createToolRegistry } from '@kindgi/tools';
import type { Semver, TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { BlockDefinition, BlockReader } from '../src/blocks.js';
import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { resolveTurnEnvironment } from '../src/handlers/turn-environment.js';
import type { AgentId } from '../src/types.js';

const tenantId = 't-1' as TenantId;

function provider(id: string, models: readonly string[]): ModelProvider {
  return {
    metadata: {
      id,
      region: 'unspecified',
      models: models.map((name) => ({
        name,
        contextWindow: 128_000,
        features: ['tool-use' as const],
        cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
      })),
    },
    invoke: async () => {
      throw new Error('not called');
    },
  };
}

const providers = createProviderRegistry([
  { tenantId, provider: provider('anthropic', ['claude-sonnet-5-5', 'claude-haiku-4-5']) },
  { tenantId, provider: provider('openai', ['gpt-6-mini']) },
]).registry;

function modelBlock(values: Record<string, unknown>): BlockDefinition {
  return { id: 'acme.model', version: '1.0.0', kind: 'settings', content: { values } };
}

function reader(block: BlockDefinition): BlockReader {
  return {
    getVersion: async ({ blockId, version }) =>
      blockId === block.id && version === block.version ? block : null,
    activeVersions: async ({ blockId }) => (blockId === block.id ? [block.version] : []),
  };
}

function turn(
  block: BlockDefinition,
  prefers: Record<string, unknown> = {},
  overrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): TurnContext {
  const r = defineAgent({
    id: 'acme.intake' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Intake',
    instructions: 'Sort it.',
    modelSettings: { id: 'acme.model', version: '^1.0.0' },
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    ...prefers,
  } as never);
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return {
    input: {
      tenantId,
      conversationId: 'conv-1',
      agent: r.value,
      ...(overrides !== undefined && { replay: { of: 'run-1', testRunId: 'eval-1' } }),
    },
    bindings: {
      toolRegistry: createToolRegistry([]),
      providerRegistry: providers,
      blockReader: reader(block),
      ...(overrides !== undefined && {
        replay: { overrides: async () => ({ settings: overrides }) },
      }),
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnContext;
}

const routed = async (ctx: TurnContext) => {
  const env = await resolveTurnEnvironment(ctx);
  return `${env.providerId}/${env.model}`;
};

describe('the model a turn prefers', () => {
  test('the model-settings block names it', async () => {
    expect(await routed(turn(modelBlock({ model: 'claude-haiku-4-5' })))).toBe(
      'anthropic/claude-haiku-4-5',
    );
    expect(await routed(turn(modelBlock({ model: 'claude-sonnet-5-5' })))).toBe(
      'anthropic/claude-sonnet-5-5',
    );
    expect(await routed(turn(modelBlock({ providerId: 'openai', temperature: 0.2 })))).toBe(
      'openai/gpt-6-mini',
    );
  });

  test("a block that names none leaves it to the agent version's preference", async () => {
    const block = modelBlock({ temperature: 0.2 });
    expect(await routed(turn(block, { preferredModel: 'claude-haiku-4-5' }))).toBe(
      'anthropic/claude-haiku-4-5',
    );
    expect(await routed(turn(block, { preferredModel: 'claude-sonnet-5-5' }))).toBe(
      'anthropic/claude-sonnet-5-5',
    );
  });

  test("a replay's override of the block's model is the one it runs", async () => {
    const block = modelBlock({ model: 'claude-sonnet-5-5' });
    expect(await routed(turn(block, {}, { 'acme.model': { model: 'claude-haiku-4-5' } }))).toBe(
      'anthropic/claude-haiku-4-5',
    );
  });
});
