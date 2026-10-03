// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { BASE_URLS, createOpenAICompatModelProvider } from '../src/index.js';

describe('createOpenAICompatModelProvider — surface', () => {
  test('metadata forwarded from options', () => {
    const p = createOpenAICompatModelProvider({
      baseURL: BASE_URLS.OPENAI,
      apiKey: 'sk-fake',
      metadata: {
        id: 'openai',
        region: 'us',
        models: [
          {
            name: 'gpt-4o-mini',
            contextWindow: 128000,
            features: ['tool-use', 'structured-output', 'streaming'],
            cost: { promptUsdPer1kTokens: 0.00015, completionUsdPer1kTokens: 0.0006 },
          },
        ],
      },
    });
    expect(p.metadata.id).toBe('openai');
    expect(p.metadata.models[0]?.name).toBe('gpt-4o-mini');
    expect(p.metadata.models[0]?.contextWindow).toBe(128000);
    expect(p.metadata.models[0]?.features).toContain('tool-use');
  });

  test('provider exposes every model listed in metadata.models', () => {
    const p = createOpenAICompatModelProvider({
      baseURL: BASE_URLS.OPENAI,
      apiKey: 'sk-fake',
      metadata: {
        id: 'openai',
        region: 'us',
        models: [
          {
            name: 'gpt-4o-mini',
            contextWindow: 128000,
            features: ['tool-use'],
            cost: { promptUsdPer1kTokens: 0.00015, completionUsdPer1kTokens: 0.0006 },
          },
          {
            name: 'gpt-4o',
            contextWindow: 128000,
            features: ['tool-use', 'structured-output'],
            cost: { promptUsdPer1kTokens: 0.005, completionUsdPer1kTokens: 0.015 },
          },
        ],
      },
    });
    expect(p.metadata.models.map((m) => m.name)).toEqual(['gpt-4o-mini', 'gpt-4o']);
  });

  test('same adapter works for a hosted endpoint and a local endpoint', () => {
    const hosted = createOpenAICompatModelProvider({
      baseURL: BASE_URLS.OPENAI,
      apiKey: 'sk-fake',
      metadata: {
        id: 'openai',
        region: 'us',
        models: [
          {
            name: 'gpt-4o-mini',
            contextWindow: 128000,
            features: ['tool-use'],
            cost: { promptUsdPer1kTokens: 0.00015, completionUsdPer1kTokens: 0.0006 },
          },
        ],
      },
    });
    const local = createOpenAICompatModelProvider({
      baseURL: BASE_URLS.OLLAMA_LOCAL,
      apiKey: 'unused',
      metadata: {
        id: 'ollama',
        region: 'local',
        models: [
          {
            name: 'llama3.2',
            contextWindow: 128000,
            features: ['tool-use'],
            cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
          },
        ],
      },
    });
    expect(hosted.metadata.region).toBe('us');
    expect(local.metadata.region).toBe('local');
    // Both implement the same interface — same call site invokes either.
    expect(typeof hosted.invoke).toBe('function');
    expect(typeof local.invoke).toBe('function');
  });
});

describe('BASE_URLS', () => {
  test('exports well-known endpoint constants', () => {
    expect(BASE_URLS.OPENAI).toBe('https://api.openai.com/v1');
    expect(BASE_URLS.OLLAMA_LOCAL).toBe('http://localhost:11434/v1');
    expect(BASE_URLS.VLLM_LOCAL).toBe('http://localhost:8000/v1');
    expect(BASE_URLS.OPENROUTER).toBe('https://openrouter.ai/api/v1');
  });
});
