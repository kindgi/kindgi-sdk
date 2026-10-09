// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent's prompt and settings can come from data blocks: references
 * by range, validated by defineAgent, loaded by a turn at one exact
 * version each (the resumed turn's own, else the agent version's pin,
 * else the range now), and used where an inline prompt or a tool's
 * constants would be: the rendered instructions, `ToolContext.settings`,
 * and the model call's settings.
 */

import { describe, expect, test } from 'vitest';

import { createToolRegistry } from '@kindgi/tools';
import type { Semver, TenantId } from '@kindgi/types';

import type { BlockDefinition, BlockReader } from '../src/blocks.js';
import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { resolveTurnBlocks } from '../src/handlers/resolve-blocks.js';
import { renderInstructions } from '../src/prompt.js';
import type { Agent, AgentId } from '../src/types.js';

const tenantId = 't-1' as TenantId;

function agent(overrides: Record<string, unknown> = {}): Agent {
  const r = defineAgent({
    id: 'acme.intake' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Intake',
    instructions: { prompt: 'acme.intake-prompt', version: '^1.0.0' },
    settings: [{ id: 'acme.weights', version: '^1.0.0' }],
    modelSettings: { id: 'acme.model', version: '^1.0.0' },
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    ...overrides,
  } as never);
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

const BLOCKS: BlockDefinition[] = [
  {
    id: 'acme.intake-prompt',
    version: '1.0.0',
    kind: 'prompt',
    content: { template: 'v1 for {{ firm }}', parameters: [{ name: 'firm', type: 'string' }] },
  },
  {
    id: 'acme.intake-prompt',
    version: '1.1.0',
    kind: 'prompt',
    content: {
      template: 'Sort it for {{ firm }}, recency {{ settings["acme.weights"].recency }}.',
      parameters: [{ name: 'firm', type: 'string', required: true }],
    },
  },
  { id: 'acme.weights', version: '1.0.0', kind: 'settings', content: { values: { recency: 0.3 } } },
  { id: 'acme.weights', version: '1.2.0', kind: 'settings', content: { values: { recency: 0.7 } } },
  {
    id: 'acme.model',
    version: '1.0.0',
    kind: 'settings',
    content: { values: { temperature: 0.2, maxOutputTokens: 400 } },
  },
];

function reader(blocks = BLOCKS): BlockReader {
  return {
    getVersion: async ({ blockId, version }) =>
      blocks.find((b) => b.id === blockId && b.version === version) ?? null,
    activeVersions: async ({ blockId }) =>
      blocks.filter((b) => b.id === blockId).map((b) => b.version),
  };
}

function turn(a: Agent, blockReader?: BlockReader): TurnContext {
  return {
    input: { tenantId, conversationId: 'c-1', agent: a },
    bindings: {
      toolRegistry: createToolRegistry(),
      ...(blockReader !== undefined && { blockReader }),
    },
  } as unknown as TurnContext;
}

describe('defineAgent and block references', () => {
  test('a prompt block, settings and model settings are references by range', () => {
    const a = agent();
    expect(a.instructions).toEqual({ prompt: 'acme.intake-prompt', version: '^1.0.0' });
    expect(a.settings).toEqual([{ id: 'acme.weights', version: '^1.0.0' }]);
    expect(a.modelSettings).toEqual({ id: 'acme.model', version: '^1.0.0' });
  });

  test('a bad range, a block named twice, and parameters next to a prompt block are refused', () => {
    const r = defineAgent({
      id: 'acme.intake' as AgentId,
      version: '1.0.0' as Semver,
      name: 'Intake',
      instructions: { prompt: 'acme.intake-prompt', version: 'not a range' },
      parameters: [{ name: 'firm', type: 'string' }],
      settings: [{ id: 'acme.weights', version: '^1.0.0' }],
      modelSettings: { id: 'acme.weights', version: '^1.0.0' },
      capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
      tools: [],
      retrieval: [],
      guardrails: [],
    } as never);
    expect(r.kind === 'err' && r.error.issues.map((i) => i.path)).toEqual([
      '/instructions/version',
      '/parameters',
      '/modelSettings/id',
    ]);
  });
});

describe('a turn loads the blocks it references', () => {
  test('an agent version with no pins resolves each range now', async () => {
    const blocks = await resolveTurnBlocks(turn(agent(), reader()));
    expect(blocks?.versions).toEqual({
      prompts: { 'acme.intake-prompt': '1.1.0' },
      settings: { 'acme.weights': '1.2.0', 'acme.model': '1.0.0' },
    });
    expect(blocks?.settings).toEqual({ 'acme.weights': { recency: 0.7 } });
    expect(blocks?.modelSettings).toEqual({ temperature: 0.2, maxOutputTokens: 400 });
  });

  test("a pinned version runs, though a newer one is in range; a resumed turn's own come first", async () => {
    const pinned = {
      ...agent(),
      pins: {
        tools: {},
        prompts: { 'acme.intake-prompt': '1.0.0' },
        settings: { 'acme.weights': '1.0.0', 'acme.model': '1.0.0' },
      },
    };
    const blocks = await resolveTurnBlocks(turn(pinned, reader()));
    expect(blocks?.prompt?.version).toBe('1.0.0');
    expect(blocks?.settings).toEqual({ 'acme.weights': { recency: 0.3 } });
    const resumed = await resolveTurnBlocks(turn(pinned, reader()), {
      prompts: { 'acme.intake-prompt': '1.1.0' },
      settings: { 'acme.weights': '1.2.0', 'acme.model': '1.0.0' },
    });
    expect(resumed?.prompt?.version).toBe('1.1.0');
  });

  test("a replay turn takes the replay's settings values (a comparison's overrides), keeping the pinned versions", async () => {
    const asked: unknown[] = [];
    const replayTurn = (overrides: Record<string, Record<string, unknown>> | undefined) => {
      const ctx = turn(agent(), reader());
      return {
        ...ctx,
        input: { ...ctx.input, replay: { of: 'run-past', evalRunId: 'eval-1' } },
        bindings: {
          ...ctx.bindings,
          replay: {
            decideTool: async () => ({ kind: 'live' as const }),
            overrides: async (input: unknown) => {
              asked.push(input);
              return overrides === undefined ? undefined : { settings: overrides };
            },
          },
        },
      } as unknown as TurnContext;
    };
    const blocks = await resolveTurnBlocks(
      replayTurn({ 'acme.weights': { recency: 0.9 }, 'acme.model': { temperature: 0.5 } }),
    );
    expect(blocks?.settings).toEqual({ 'acme.weights': { recency: 0.9 } });
    expect(blocks?.modelSettings).toEqual({ temperature: 0.5 });
    expect(blocks?.versions.settings).toEqual({ 'acme.weights': '1.2.0', 'acme.model': '1.0.0' });
    expect(asked).toEqual([{ tenantId, replay: { of: 'run-past', evalRunId: 'eval-1' } }]);

    const plain = await resolveTurnBlocks(replayTurn(undefined));
    expect(plain?.settings).toEqual({ 'acme.weights': { recency: 0.7 } });
    await expect(
      resolveTurnBlocks(replayTurn({ 'acme.model': { temperature: 9 } })),
    ).rejects.toThrow(/with the replay's values/);
  });

  test("a replay turn takes the replay's prompt template, keeping the block's parameters", async () => {
    const ctx = turn(agent(), reader());
    const blocks = await resolveTurnBlocks({
      ...ctx,
      input: { ...ctx.input, replay: { of: 'run-past', evalRunId: 'eval-1' } },
      bindings: {
        ...ctx.bindings,
        replay: {
          decideTool: async () => ({ kind: 'live' as const }),
          overrides: async () => ({
            prompts: { 'acme.intake-prompt': { template: 'Sort it, {{ firm }}.' } },
          }),
        },
      },
    } as unknown as TurnContext);
    expect(blocks?.prompt).toMatchObject({
      id: 'acme.intake-prompt',
      version: '1.1.0',
      content: { template: 'Sort it, {{ firm }}.', parameters: [{ name: 'firm' }] },
    });
  });

  test('a turn that is not a replay never asks for replay settings', async () => {
    let asked = 0;
    const ctx = turn(agent(), reader());
    const blocks = await resolveTurnBlocks({
      ...ctx,
      bindings: {
        ...ctx.bindings,
        replay: {
          decideTool: async () => ({ kind: 'live' as const }),
          overrides: async () => {
            asked += 1;
            return { settings: { 'acme.weights': { recency: 0.9 } } };
          },
        },
      },
    } as unknown as TurnContext);
    expect(asked).toBe(0);
    expect(blocks?.settings).toEqual({ 'acme.weights': { recency: 0.7 } });
  });

  test('the prompt block renders as the instructions, reading the settings', async () => {
    const a = agent();
    const blocks = await resolveTurnBlocks(turn(a, reader()));
    const rendered = renderInstructions(
      a,
      { parameters: { firm: 'Acme' }, settings: blocks?.settings ?? {} },
      blocks?.prompt?.content,
    );
    expect(rendered.ok && rendered.value.rendered).toBe('Sort it for Acme, recency 0.7.');
  });

  test('a block that cannot load fails the turn: no runtime support, nothing in range, not model settings', async () => {
    const failure = async (ctx: TurnContext) => {
      try {
        await resolveTurnBlocks(ctx);
      } catch (error) {
        return (error as AgentTurnFailure).payload;
      }
      return undefined;
    };
    expect(await failure(turn(agent()))).toMatchObject({
      code: 'block-unresolvable',
      message: expect.stringContaining('this runtime serves none'),
    });
    expect(
      await failure(
        turn(agent({ settings: [{ id: 'acme.weights', version: '^3.0.0' }] }), reader()),
      ),
    ).toMatchObject({ code: 'block-unresolvable', blockId: 'acme.weights' });
    const notModel = BLOCKS.map((b) =>
      b.id === 'acme.model' ? { ...b, content: { values: { temperature: 'hot' } } } : b,
    ) as BlockDefinition[];
    expect(await failure(turn(agent(), reader(notModel)))).toMatchObject({
      code: 'block-unresolvable',
      message: expect.stringContaining("isn't model settings"),
    });
    expect(AgentTurnFailure).toBeDefined();
  });

  test('an agent that references no blocks loads none', async () => {
    expect(
      await resolveTurnBlocks(
        turn(agent({ instructions: 'Inline.', settings: undefined, modelSettings: undefined })),
      ),
    ).toBeUndefined();
  });
});
