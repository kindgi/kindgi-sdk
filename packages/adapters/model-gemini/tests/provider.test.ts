// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import type { ProviderMetadata } from '@kindgi/capabilities';
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_CACHED_PROMPT_MULTIPLIER,
  type GeminiClient,
  type GeminiProviderOptions,
  computeCostUsd,
  createGeminiProvider,
  geminiAdapterFactory,
  toFrameworkUsage,
  vertexTarget,
} from '../src/index.js';
import { parseServiceAccountKey } from '../src/provider.js';

const METADATA: GeminiProviderOptions['metadata'] = {
  id: 'gemini-vertex',
  region: 'global',
  models: [
    {
      name: 'gemini-2.5-pro',
      contextWindow: 1_048_576,
      features: ['tool-use'],
      maxOutputTokens: 8192,
      cost: {
        promptUsdPer1kTokens: 0.00125,
        completionUsdPer1kTokens: 0.01,
        longContext: {
          thresholdTokens: 200_000,
          promptUsdPer1kTokens: 0.0025,
          completionUsdPer1kTokens: 0.015,
        },
      },
    },
  ],
};

function fakeClient(answer: Partial<GenerateContentResponse>): GeminiClient & {
  readonly calls: GenerateContentParameters[];
} {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      async generateContent(params) {
        calls.push(params);
        return answer as GenerateContentResponse;
      },
    },
  };
}

const OK_ANSWER: Partial<GenerateContentResponse> = {
  candidates: [
    { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' as never },
  ],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
  modelVersion: 'gemini-2.5-pro-001',
  responseId: 'resp-42',
};

describe('createGeminiProvider', () => {
  test('sends the model, contents and config; maps the answer, usage and cost', async () => {
    const client = fakeClient(OK_ANSWER);
    const provider = createGeminiProvider({
      metadata: METADATA,
      vertex: { project: 'acme-dev', location: 'global' },
      client,
    });
    const abort = new AbortController();
    const result = await provider.invoke({
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ name: 'acme.search', description: 'Search', inputSchema: { type: 'object' } }],
      structuredOutput: { name: 'answer', schema: { type: 'object' } },
      temperature: 0.2,
      abortSignal: abort.signal,
    });

    expect(client.calls).toEqual([
      {
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: {
          systemInstruction: 'Be brief.',
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'acme.search',
                  description: 'Search',
                  parametersJsonSchema: { type: 'object' },
                },
              ],
            },
          ],
          responseMimeType: 'application/json',
          responseJsonSchema: { type: 'object' },
          temperature: 0.2,
          maxOutputTokens: 8192,
          abortSignal: abort.signal,
        },
      },
    ]);
    expect(result).toMatchObject({
      message: { role: 'assistant', content: 'done' },
      finishReason: 'stop',
      usage: { promptTokens: 1000, completionTokens: 150, reasoningTokens: 50 },
      provider: { id: 'gemini-vertex', model: 'gemini-2.5-pro' },
      servedModel: 'gemini-2.5-pro-001',
      providerRequestId: 'resp-42',
      rawUsage: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
    });
    // The injected client sends with its own fetch: no attempts were counted.
    expect(result.attempts).toBeUndefined();
    expect(result.costUsd).toBeCloseTo((1000 * 0.00125 + 150 * 0.01) / 1000, 12);
  });

  test('an unknown model is refused before any call', async () => {
    const client = fakeClient(OK_ANSWER);
    const provider = createGeminiProvider({
      metadata: METADATA,
      vertex: { project: 'acme-dev', location: 'global' },
      client,
    });
    await expect(provider.invoke({ model: 'gemini-x', messages: [] })).rejects.toThrow(
      /does not expose model "gemini-x"/,
    );
    expect(client.calls).toEqual([]);
  });

  test('a credential that is not a service-account key fails clearly', async () => {
    const provider = createGeminiProvider({
      metadata: METADATA,
      vertex: { project: 'acme-dev', location: 'global' },
      credentials: async () => 'not json',
    });
    await expect(
      provider.invoke({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/isn't a service-account key/);
  });
});

describe('usage and cost', () => {
  test('thinking counts as completion, and is reported apart; cached and tool-prompt tokens count as prompt', () => {
    expect(
      toFrameworkUsage({
        promptTokenCount: 900,
        toolUsePromptTokenCount: 100,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 60,
        cachedContentTokenCount: 400,
      }),
    ).toEqual({
      promptTokens: 1000,
      completionTokens: 100,
      cacheReadTokens: 400,
      reasoningTokens: 60,
    });
    expect(toFrameworkUsage(undefined)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  test('a part Gemini reports as 0 is kept as 0; one it leaves out is absent', () => {
    expect(
      toFrameworkUsage({
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 0,
        cachedContentTokenCount: 0,
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 });
    expect(toFrameworkUsage({ promptTokenCount: 10, candidatesTokenCount: 2 })).toEqual({
      promptTokens: 10,
      completionTokens: 2,
    });
  });

  test('cached prompt tokens bill at the cached share; long prompts at the long-context rates', () => {
    const rates = METADATA.models[0]?.cost;
    if (rates === undefined) throw new Error('no rates');
    expect(
      computeCostUsd({ promptTokens: 1000, completionTokens: 100, cacheReadTokens: 400 }, rates),
    ).toBeCloseTo(
      (600 * 0.00125 + 400 * 0.00125 * DEFAULT_CACHED_PROMPT_MULTIPLIER + 100 * 0.01) / 1000,
      12,
    );
    expect(computeCostUsd({ promptTokens: 300_000, completionTokens: 1000 }, rates)).toBeCloseTo(
      (300_000 * 0.0025 + 1000 * 0.015) / 1000,
      9,
    );
  });
});

describe('what a registration can make the adapter reach', () => {
  const metadata: ProviderMetadata = { ...METADATA, region: 'unspecified' };

  test('the region is one DNS label: it becomes <region>-aiplatform.googleapis.com', () => {
    for (const region of [
      'evil.example/x?',
      'evil.example#',
      'a.b',
      'US-CENTRAL1',
      '169.254.169.254',
    ]) {
      expect(() =>
        vertexTarget({ metadata: { ...metadata, region }, config: { project: 'acme-dev' } }),
      ).toThrow(/must be a Vertex AI location/);
      expect(() =>
        createGeminiProvider({ metadata, vertex: { project: 'acme-dev', location: region } }),
      ).toThrow(/must be a Vertex AI location/);
    }
  });

  test('the project is a project id or number: it goes into the request path', () => {
    for (const project of ['acme/../x', 'acme?x', 'a', 'Acme-Dev']) {
      expect(() => vertexTarget({ metadata, config: { project } })).toThrow(
        /must be a Google Cloud project id or number/,
      );
    }
    expect(vertexTarget({ metadata, config: { project: '123456789012' } }).project).toBe(
      '123456789012',
    );
  });

  test('a key must be a service account; nothing in it can name a URL, a file or a token endpoint', () => {
    const external = JSON.stringify({
      type: 'external_account',
      client_email: 'x@acme.iam.gserviceaccount.com',
      private_key: 'k',
      credential_source: { url: 'http://169.254.169.254/', file: '/etc/passwd' },
      token_url: 'https://evil.example/token',
    });
    expect(() => parseServiceAccountKey(external)).toThrow(/"type": "service_account"/);
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ client_email: 'x', private_key: 'k' })),
    ).toThrow(/"type": "service_account"/);
    expect(
      parseServiceAccountKey(
        JSON.stringify({
          type: 'service_account',
          project_id: 'acme-dev',
          private_key_id: 'abc',
          private_key: 'k',
          client_email: 'x@acme-dev.iam.gserviceaccount.com',
          client_id: '1',
          token_uri: 'https://evil.example/token',
          universe_domain: 'evil.example',
          auth_uri: 'https://evil.example/auth',
        }),
      ),
    ).toEqual({
      type: 'service_account',
      project_id: 'acme-dev',
      private_key_id: 'abc',
      private_key: 'k',
      client_email: 'x@acme-dev.iam.gserviceaccount.com',
      client_id: '1',
    });
  });
});

describe('geminiAdapterFactory', () => {
  const metadata: ProviderMetadata = { ...METADATA, region: 'unspecified' };

  test('needs adapter_config.project', () => {
    expect(() => geminiAdapterFactory({ metadata })).toThrow(/needs adapter_config.project/);
    expect(() => geminiAdapterFactory({ metadata, config: { project: '' } })).toThrow(
      /needs adapter_config.project/,
    );
  });

  test('builds a provider from the registration; the region is the location', () => {
    const provider = geminiAdapterFactory({ metadata, config: { project: 'acme-dev' } });
    expect(provider.metadata).toBe(metadata);
    expect(vertexTarget({ metadata, config: { project: 'acme-dev' } })).toEqual({
      project: 'acme-dev',
      location: 'global',
    });
    expect(
      vertexTarget({
        metadata: { ...metadata, region: 'northamerica-northeast1' },
        config: { project: 'acme-dev' },
      }),
    ).toEqual({ project: 'acme-dev', location: 'northamerica-northeast1' });
  });
});

describe('a long prompt', () => {
  test("prices at the registration's long-context rates", async () => {
    const client = fakeClient({
      ...OK_ANSWER,
      usageMetadata: { promptTokenCount: 300_000, candidatesTokenCount: 1000 },
    });
    const provider = createGeminiProvider({
      metadata: METADATA,
      vertex: { project: 'acme-dev', location: 'global' },
      client,
    });
    const result = await provider.invoke({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'Summarize the attached corpus.' }],
    });
    expect(result.costUsd).toBeCloseTo((300_000 * 0.0025 + 1000 * 0.015) / 1000, 10);
  });
});
