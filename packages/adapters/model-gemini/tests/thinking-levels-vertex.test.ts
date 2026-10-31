// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How much a model thinks on a Vertex AI registration: the provider the
 * factory builds sends each model its `thinking.default` when a call asks
 * none, and a stored `adapter_config.thinkingLevels` isn't read. The SDK
 * class is replaced by one that records what each call asks for, so no
 * Google credentials or network are needed (the Developer API's wire is
 * in `thinking-levels.test.ts`).
 */

import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAIOptions,
} from '@google/genai';
import type { ThinkingLevel } from '@kindgi/capabilities';
import { describe, expect, test, vi } from 'vitest';

import { geminiAdapterFactory } from '../src/index.js';

const built: GoogleGenAIOptions[] = [];
const calls: GenerateContentParameters[] = [];

vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    readonly models = {
      async generateContent(params: GenerateContentParameters) {
        calls.push(params);
        return {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        } as unknown as GenerateContentResponse;
      },
    };
    constructor(options: GoogleGenAIOptions) {
      built.push(options);
    }
  },
}));

const model = (name: string, lowest: string, level?: ThinkingLevel) => ({
  name,
  contextWindow: 1_048_576,
  features: ['tool-use' as const],
  cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
  thinking: { mode: 'adaptive' as const, lowest, ...(level !== undefined && { default: level }) },
});

describe('how much a model thinks on Vertex AI', () => {
  test("each model is sent its default; a stored thinkingLevels isn't read", async () => {
    const provider = geminiAdapterFactory({
      metadata: {
        id: 'acme-gemini',
        region: 'global',
        models: [
          model('gemini-3.8-flash', 'low', 'high'),
          model('gemini-3.5-flash-lite', 'minimal'),
        ],
      },
      config: { project: 'acme-project', thinkingLevels: 'gemini-3.5-flash-lite=low' },
    });
    const results = [];
    for (const name of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
      results.push(
        await provider.invoke({ model: name, messages: [{ role: 'user', content: 'hi' }] }),
      );
    }
    expect(built).toMatchObject([{ vertexai: true, project: 'acme-project', location: 'global' }]);
    expect(calls.map((c) => c.config?.thinkingConfig)).toEqual([
      { thinkingLevel: 'HIGH' },
      undefined,
    ]);
    expect(results.map((r) => r.thinking)).toEqual([
      { level: 'high', sent: { thinkingLevel: 'HIGH' } },
      undefined,
    ]);
  });
});
