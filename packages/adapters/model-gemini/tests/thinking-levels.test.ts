// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `thinkingLevels`: how much each model thinks, set on a provider in code
 * (`GeminiProviderOptions.thinkingLevels`) or on a registration
 * (`adapter_config.thinkingLevels`, `"model=level,…"`). Each named model
 * gets its level on every call; one it doesn't name gets none; a call's
 * `thinking: 'lowest'` still wins. The check refuses what the factory
 * would throw on, with the same message.
 */

import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { type AdapterConfig, adapterConfigError } from '@kindgi/capabilities';
import { afterEach, describe, expect, test } from 'vitest';

import {
  GEMINI_ADAPTER_ID,
  type GeminiClient,
  type GeminiProviderOptions,
  createGeminiProvider,
  geminiAdapterFactory,
  geminiCheckConfig,
} from '../src/index.js';

const model = (name: string, lowest?: string) => ({
  name,
  contextWindow: 1_048_576,
  features: ['tool-use' as const],
  cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
  ...(lowest !== undefined && { thinking: { mode: 'adaptive' as const, lowest } }),
});

const METADATA: GeminiProviderOptions['metadata'] = {
  id: 'acme-gemini',
  region: 'global',
  models: [
    model('gemini-3.8-flash', 'low'),
    model('gemini-3.5-flash-lite', 'minimal'),
    model('gemini-3.1-pro-preview'),
  ],
};

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

describe('GeminiProviderOptions.thinkingLevels', () => {
  /** The thinkingConfig one call to `name` sends. */
  async function sent(
    thinkingLevels: GeminiProviderOptions['thinkingLevels'],
    name: string,
    lowest = false,
  ) {
    const client = fakeClient();
    const provider = createGeminiProvider({
      metadata: METADATA,
      vertex: { project: 'acme-dev', location: 'global' },
      client,
      ...(thinkingLevels !== undefined && { thinkingLevels }),
    });
    await provider.invoke({
      model: name,
      messages: [{ role: 'user', content: 'hi' }],
      ...(lowest && { thinking: 'lowest' as const }),
    });
    return client.calls[0]?.config?.thinkingConfig;
  }

  test("sends each named model's level, upper-cased; a model it doesn't name gets none", async () => {
    const levels = { 'gemini-3.8-flash': 'medium', 'gemini-3.5-flash-lite': 'minimal' } as const;
    expect(await sent(levels, 'gemini-3.8-flash')).toEqual({ thinkingLevel: 'MEDIUM' });
    expect(await sent(levels, 'gemini-3.5-flash-lite')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(await sent(levels, 'gemini-3.1-pro-preview')).toBeUndefined();
    expect(await sent({ 'gemini-3.8-flash': 'high' }, 'gemini-3.5-flash-lite')).toBeUndefined();
  });

  test('unset, nothing is sent', async () => {
    expect(await sent(undefined, 'gemini-3.8-flash')).toBeUndefined();
  });

  test("a call's thinking: 'lowest' still sends the model's lowest", async () => {
    expect(await sent({ 'gemini-3.8-flash': 'high' }, 'gemini-3.8-flash', true)).toEqual({
      thinkingLevel: 'LOW',
    });
  });

  test('a level the model refuses is refused when the provider is made, an injected client too', () => {
    expect(() =>
      createGeminiProvider({
        metadata: METADATA,
        client: fakeClient(),
        thinkingLevels: { 'gemini-3.8-flash': 'minimal' },
      }),
    ).toThrow(
      'adapter_config.thinkingLevels gives gemini-3.8-flash "minimal", below its thinking.lowest: it thinks at "low" at the least.',
    );
  });
});

describe('adapter_config.thinkingLevels: the check agrees with the factory', () => {
  /** The check's problems for a registration, and what the factory throws for it. */
  function both(config: AdapterConfig, models = METADATA.models) {
    const metadata = { ...METADATA, models };
    const problems = geminiCheckConfig({ metadata, config, hasSecretRef: true });
    let thrown: string | undefined;
    try {
      geminiAdapterFactory({ metadata, config, resolveApiKey: async () => 'unused' });
    } catch (err) {
      thrown = (err as Error).message;
    }
    return { problems, thrown };
  }

  test.each([
    ['Vertex AI', { project: 'acme-project', thinkingLevels: 'gemini-3.8-flash=low' }],
    [
      'the Developer API, two models, spaces around each part',
      {
        api: 'developer',
        thinkingLevels: ' gemini-3.8-flash = high , gemini-3.5-flash-lite=minimal',
      },
    ],
  ] as const)('%s: no problems, and the factory builds it', (_name, config) => {
    expect(both(config)).toEqual({ problems: [], thrown: undefined });
  });

  test("a model's lowest is read in any case", () => {
    const models = [model('gemini-3.8-flash', 'LOW')];
    expect(
      both({ project: 'acme-project', thinkingLevels: 'gemini-3.8-flash=low' }, models),
    ).toEqual({ problems: [], thrown: undefined });
  });

  describe.each([
    ['Vertex AI', { project: 'acme-project' }],
    ['the Developer API', { api: 'developer' }],
  ] as const)('on %s', (_api, target) => {
    test.each([
      ['not a string', true, 'must be "model=level,…" (e.g. "gemini-3.8-flash=low"), got true.'],
      ['empty', ' ', 'must be "model=level,…" (e.g. "gemini-3.8-flash=low"), got " ".'],
      [
        'an entry without a level',
        'gemini-3.8-flash',
        'has "gemini-3.8-flash": each entry is model=level.',
      ],
      [
        'an entry with two',
        'gemini-3.8-flash=low=high',
        'has "gemini-3.8-flash=low=high": each entry is model=level.',
      ],
      [
        'a model named twice',
        'gemini-3.8-flash=low,gemini-3.8-flash=high',
        'names gemini-3.8-flash twice: one level each.',
      ],
      [
        'a model the registration does not list',
        'gemini-9-ultra=low',
        "names gemini-9-ultra, which this registration doesn't list in metadata.models.",
      ],
      [
        'a model with no thinking',
        'gemini-3.1-pro-preview=low',
        "names gemini-3.1-pro-preview, which has no thinking in metadata.models: it isn't known to think.",
      ],
      [
        'a level Gemini does not have',
        'gemini-3.8-flash=none',
        'gives gemini-3.8-flash "none": a level is minimal, low, medium or high.',
      ],
      [
        'a level in capitals (levels are lowercase)',
        'gemini-3.8-flash=LOW',
        'gives gemini-3.8-flash "LOW": a level is minimal, low, medium or high.',
      ],
      [
        "a level under the model's lowest",
        'gemini-3.8-flash=minimal',
        'gives gemini-3.8-flash "minimal", below its thinking.lowest: it thinks at "low" at the least.',
      ],
    ] as const)(
      '%s: the check points at thinkingLevels, and the factory throws the same message',
      (_name, thinkingLevels, says) => {
        const { problems, thrown } = both({ ...target, thinkingLevels });
        expect(problems).toEqual([
          {
            path: '/adapter_config/thinkingLevels',
            message: `adapter_config.thinkingLevels ${says}`,
          },
        ]);
        expect(thrown).toBe(
          adapterConfigError(GEMINI_ADAPTER_ID, 'acme-gemini', problems[0]!).message,
        );
      },
    );
  });

  test("a model whose lowest isn't a Gemini level is refused by name, not compared", () => {
    const models = [model('gemini-3.8-flash', 'off')];
    const { problems, thrown } = both(
      { project: 'acme-project', thinkingLevels: 'gemini-3.8-flash=high' },
      models,
    );
    expect(problems).toEqual([
      {
        path: '/adapter_config/thinkingLevels',
        message:
          'adapter_config.thinkingLevels names gemini-3.8-flash, whose thinking.lowest "off" isn\'t a Gemini thinking level (minimal, low, medium or high), so its least isn\'t known.',
      },
    ]);
    expect(thrown).toBe(adapterConfigError(GEMINI_ADAPTER_ID, 'acme-gemini', problems[0]!).message);
  });

  test('each bad entry is reported, after the target', () => {
    const { problems } = both({
      project: 'x',
      thinkingLevels: 'gemini-9-ultra=low,gemini-3.8-flash=none',
    });
    expect(problems.map((p) => p.path)).toEqual([
      '/adapter_config/project',
      '/adapter_config/thinkingLevels',
      '/adapter_config/thinkingLevels',
    ]);
  });
});

describe('adapter_config.thinkingLevels on the wire', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test('a registered provider sends each named model its level, and none to the others', async () => {
    const bodies: string[] = [];
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json(ANSWER);
    };
    const provider = geminiAdapterFactory({
      metadata: METADATA,
      config: { api: 'developer', thinkingLevels: 'gemini-3.8-flash=low' },
      resolveApiKey: async () => 'k',
    });
    for (const name of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
      await provider.invoke({ model: name, messages: [{ role: 'user', content: 'hi' }] });
    }
    const thinkingConfigs = bodies.map(
      (b) =>
        (JSON.parse(b) as { generationConfig?: { thinkingConfig?: unknown } }).generationConfig
          ?.thinkingConfig,
    );
    expect(thinkingConfigs).toEqual([{ thinkingLevel: 'LOW' }, undefined]);
  });
});
