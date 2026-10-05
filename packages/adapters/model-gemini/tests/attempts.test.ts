// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The client the provider builds sends through the attempt counter's
 * `fetch` (`httpOptions.fetch`): every request the SDK sends for a call,
 * a retry included, is counted for it. The SDK class is replaced by one
 * that sends the way it does, through the `fetch` it was given, so no
 * Google credentials or network are needed.
 */

import type { GenerateContentResponse, GoogleGenAIOptions } from '@google/genai';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createGeminiProvider } from '../src/index.js';

const built: GoogleGenAIOptions[] = [];

vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    readonly models: { generateContent(): Promise<GenerateContentResponse> };
    constructor(options: GoogleGenAIOptions) {
      built.push(options);
      const send = options.httpOptions?.fetch ?? globalThis.fetch;
      this.models = {
        async generateContent() {
          // The SDK's own retry: a 503, then the answer.
          for (;;) {
            const response = await send('https://aiplatform.test/v1/generateContent');
            if (response.ok) return (await response.json()) as GenerateContentResponse;
          }
        },
      };
    }
  },
}));

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe('createGeminiProvider: attempts', () => {
  test('a retried call counts both requests the SDK sent', async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      if (requests === 1) return new Response('unavailable', { status: 503 });
      return Response.json({
        candidates: [
          { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        modelVersion: 'gemini-2.5-pro-001',
      });
    };
    const provider = createGeminiProvider({
      metadata: {
        id: 'gemini-vertex',
        region: 'global',
        models: [
          {
            name: 'gemini-2.5-pro',
            contextWindow: 1_048_576,
            features: [],
            cost: { promptUsdPer1kTokens: 0.00125, completionUsdPer1kTokens: 0.01 },
          },
        ],
      },
      vertex: { project: 'acme-dev', location: 'global' },
    });
    const result = await provider.invoke({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(built).toHaveLength(1);
    expect(built[0]?.httpOptions?.fetch).toBeTypeOf('function');
    expect(requests).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.servedModel).toBe('gemini-2.5-pro-001');
  });
});
