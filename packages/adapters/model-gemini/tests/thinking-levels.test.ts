// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How much a Gemini model thinks: the call's `thinking`, or the model's
 * `thinking.default` when the call asks none, sent as `thinkingLevel`,
 * upper-cased. A level the model doesn't take is rounded to one it does
 * (`thinking-level-adjusted`); a model with no `thinking` is sent none
 * (`thinking-unsupported`). The result reports the level and what was
 * sent. `adapter_config.thinkingLevels` is no longer read: a stored one
 * builds and changes nothing.
 */

import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import type { ModelInfo, ModelThinking, ThinkingLevel } from '@kindgi/capabilities';
import { afterEach, describe, expect, test } from 'vitest';

import {
  type GeminiClient,
  createGeminiProvider,
  geminiAdapterFactory,
  geminiCheckConfig,
} from '../src/index.js';

const NAME = 'gemini-3.8-flash';

const model = (thinking?: ModelThinking): ModelInfo => ({
  name: NAME,
  contextWindow: 1_048_576,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
  ...(thinking !== undefined && { thinking }),
});

const ANSWER: Partial<GenerateContentResponse> = {
  candidates: [
    { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' as never },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
};

function fakeClient(): GeminiClient & { readonly calls: GenerateContentParameters[] } {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      async generateContent(params) {
        calls.push(params);
        return ANSWER as GenerateContentResponse;
      },
    },
  };
}

/** One call to a model with this `thinking`: what it sent, and what it reported. */
async function call(thinking: ModelThinking | undefined, asked?: ThinkingLevel) {
  const client = fakeClient();
  const provider = createGeminiProvider({
    metadata: { id: 'acme-gemini', region: 'global', models: [model(thinking)] },
    vertex: { project: 'acme-dev', location: 'global' },
    client,
  });
  const result = await provider.invoke({
    model: NAME,
    messages: [{ role: 'user', content: 'hi' }],
    ...(asked !== undefined && { thinking: asked }),
  });
  return {
    thinkingConfig: client.calls[0]?.config?.thinkingConfig,
    thinking: result.thinking,
    warnings: result.warnings,
  };
}

const adjusted = (asked: string, level: string) => [
  {
    code: 'thinking-level-adjusted',
    message: `${NAME} doesn't take thinking level ${asked}, so the call sent ${level}.`,
  },
];

describe('each level', () => {
  const TAKES: ModelThinking = {
    mode: 'adaptive',
    lowest: 'minimal',
    levels: ['low', 'medium', 'high'],
  };

  test.each([
    ['lowest', 'MINIMAL'],
    ['low', 'LOW'],
    ['medium', 'MEDIUM'],
    ['high', 'HIGH'],
  ] as const)('%s is sent as thinkingLevel %s, and reported', async (asked, thinkingLevel) => {
    expect(await call(TAKES, asked)).toEqual({
      thinkingConfig: { thinkingLevel },
      thinking: { level: asked, sent: { thinkingLevel } },
      warnings: undefined,
    });
  });

  test.each([
    ['minimal', 'low', 'LOW'],
    ['xhigh', 'high', 'HIGH'],
    ['max', 'high', 'HIGH'],
  ] as const)(
    "%s, which it doesn't take, is sent as %s, with a warning",
    async (asked, level, thinkingLevel) => {
      expect(await call(TAKES, asked)).toEqual({
        thinkingConfig: { thinkingLevel },
        thinking: { level, sent: { thinkingLevel } },
        warnings: adjusted(asked, level),
      });
    },
  );

  test("lowest sends the model's own lowest, in any case", async () => {
    expect(await call({ mode: 'adaptive', lowest: 'LOW' }, 'lowest')).toEqual({
      thinkingConfig: { thinkingLevel: 'LOW' },
      thinking: { level: 'lowest', sent: { thinkingLevel: 'LOW' } },
      warnings: undefined,
    });
  });
});

describe('rounding', () => {
  test.each([
    // Without levels: the ones every thinking model takes, from its lowest.
    ['at the floor, no levels', { lowest: 'low' }, 'minimal', 'low', 'LOW'],
    ['above the ceiling, no levels', { lowest: 'minimal' }, 'max', 'high', 'HIGH'],
    ['a lowest of medium, no levels', { lowest: 'medium' }, 'low', 'medium', 'MEDIUM'],
    ['minimal, when lowest is minimal', { lowest: 'minimal' }, 'minimal', 'minimal', 'MINIMAL'],
    // With levels: only those.
    [
      'at the floor, levels',
      { lowest: 'low', levels: ['medium', 'high'] },
      'low',
      'medium',
      'MEDIUM',
    ],
    ['in a gap, levels', { lowest: 'low', levels: ['low', 'high'] }, 'medium', 'high', 'HIGH'],
    [
      'above the ceiling, levels',
      { lowest: 'low', levels: ['low', 'medium'] },
      'high',
      'medium',
      'MEDIUM',
    ],
  ] as const)('%s: asked %s, it sends %s', async (_name, t, asked, level, thinkingLevel) => {
    expect(await call({ mode: 'adaptive', ...t }, asked)).toEqual({
      thinkingConfig: { thinkingLevel },
      thinking: { level, sent: { thinkingLevel } },
      warnings: asked === level ? undefined : adjusted(asked, level),
    });
  });
});

describe("the model's default", () => {
  test('a call that asks none is sent the default, as registered, with no warning', async () => {
    expect(await call({ mode: 'adaptive', lowest: 'low', default: 'medium' })).toEqual({
      thinkingConfig: { thinkingLevel: 'MEDIUM' },
      thinking: { level: 'medium', sent: { thinkingLevel: 'MEDIUM' } },
      warnings: undefined,
    });
  });

  test("a default of lowest sends the model's lowest", async () => {
    expect(
      (await call({ mode: 'adaptive', lowest: 'minimal', default: 'lowest' })).thinkingConfig,
    ).toEqual({ thinkingLevel: 'MINIMAL' });
  });

  test("the call's level beats the default", async () => {
    expect(await call({ mode: 'adaptive', lowest: 'low', default: 'medium' }, 'high')).toEqual({
      thinkingConfig: { thinkingLevel: 'HIGH' },
      thinking: { level: 'high', sent: { thinkingLevel: 'HIGH' } },
      warnings: undefined,
    });
  });

  test('no level asked and no default: nothing is sent or reported', async () => {
    expect(await call({ mode: 'adaptive', lowest: 'low' })).toEqual({
      thinkingConfig: undefined,
      thinking: undefined,
      warnings: undefined,
    });
  });
});

describe('a model with no thinking', () => {
  test('a level asked is sent nowhere, with a warning', async () => {
    expect(await call(undefined, 'high')).toEqual({
      thinkingConfig: undefined,
      thinking: undefined,
      warnings: [
        {
          code: 'thinking-unsupported',
          message: `${NAME} doesn't think, or how it thinks isn't known, so the call sent no level (it asked for high).`,
        },
      ],
    });
  });

  test('none asked: nothing, and no warning', async () => {
    expect(await call(undefined)).toEqual({
      thinkingConfig: undefined,
      thinking: undefined,
      warnings: undefined,
    });
  });
});

describe('a stored adapter_config.thinkingLevels', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const metadata = (thinking: ModelThinking) => ({
    id: 'acme-gemini',
    region: 'global',
    models: [model(thinking)],
  });
  const config = { api: 'developer', thinkingLevels: `${NAME}=high` };

  test('its check leaves it be', () => {
    expect(
      geminiCheckConfig({
        metadata: metadata({ mode: 'adaptive', lowest: 'low' }),
        config,
        hasSecretRef: true,
      }),
    ).toEqual([]);
  });

  test("it builds and isn't read: the model's default is sent, or nothing", async () => {
    const bodies: string[] = [];
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json(ANSWER);
    };
    const thinkings: readonly ModelThinking[] = [
      { mode: 'adaptive', lowest: 'low' },
      { mode: 'adaptive', lowest: 'low', default: 'low' },
    ];
    for (const thinking of thinkings) {
      const provider = geminiAdapterFactory({
        metadata: metadata(thinking),
        config,
        resolveApiKey: async () => 'k',
      });
      await provider.invoke({ model: NAME, messages: [{ role: 'user', content: 'hi' }] });
    }
    const thinkingConfigs = bodies.map(
      (b) =>
        (JSON.parse(b) as { generationConfig?: { thinkingConfig?: unknown } }).generationConfig
          ?.thinkingConfig,
    );
    expect(thinkingConfigs).toEqual([undefined, { thinkingLevel: 'LOW' }]);
  });
});
