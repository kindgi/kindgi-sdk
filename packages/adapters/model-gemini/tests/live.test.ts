// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Live validation against Vertex AI. Gated on `GOOGLE_CLOUD_PROJECT`
 * (Google's own variable) and Application Default Credentials — the
 * test skips, not fails, without them, so CI stays green without a
 * Google project. `GOOGLE_CLOUD_LOCATION` picks the location (default
 * `global`), `KINDGI_LIVE_GEMINI_MODEL` the model (default
 * `gemini-2.5-flash`).
 *
 * Covers a plain answer and a full tool round trip: the model calls a
 * function, the result goes back with the call's thought signature, and
 * the model answers from it. Mocks can't show that Vertex accepts the
 * request shape; only a real call can.
 */

import { beforeAll, describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';

import { type GeminiProviderOptions, createGeminiProvider } from '../src/index.js';

const project = process.env.GOOGLE_CLOUD_PROJECT;
const gated = project === undefined || project.length === 0;
const model = process.env.KINDGI_LIVE_GEMINI_MODEL ?? 'gemini-2.5-flash';

const METADATA: GeminiProviderOptions['metadata'] = {
  id: 'gemini-live',
  region: process.env.GOOGLE_CLOUD_LOCATION ?? 'global',
  models: [
    {
      name: model,
      contextWindow: 1_048_576,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.0003, completionUsdPer1kTokens: 0.0025 },
    },
  ],
};

describe.skipIf(gated)('Gemini on Vertex — live', () => {
  // Built when the tests run, not while vitest collects them: the provider
  // checks its project, which is empty when the suite is skipped.
  let provider: ReturnType<typeof createGeminiProvider>;
  beforeAll(() => {
    provider = createGeminiProvider({
      metadata: METADATA,
      vertex: { project: project ?? '', location: METADATA.region },
    });
  });

  test('a plain answer, with usage and cost', async () => {
    const r = await provider.invoke({
      model,
      messages: [
        { role: 'system', content: 'Answer with one word.' },
        { role: 'user', content: 'What colour is a clear daytime sky?' },
      ],
      maxOutputTokens: 512,
    });
    expect(r.finishReason).toBe('stop');
    expect(r.message.content.toLowerCase()).toContain('blue');
    expect(r.usage.promptTokens).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
  }, 60_000);

  test('a tool round trip: the call, its result with the signature, the answer', async () => {
    const tools = [
      {
        name: 'acme.case-count',
        description: 'How many precedent cases match a remedy.',
        inputSchema: {
          type: 'object',
          properties: { remedy: { type: 'string' } },
          required: ['remedy'],
        },
      },
    ];
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Use the tool: how many cases match the remedy "backpay"?' },
    ];
    const first = await provider.invoke({ model, messages, tools, maxOutputTokens: 1024 });
    expect(first.finishReason).toBe('tool-use');
    const call = first.message.toolCalls?.[0];
    expect(call).toMatchObject({ name: 'acme.case-count', arguments: { remedy: 'backpay' } });

    const second = await provider.invoke({
      model,
      messages: [
        ...messages,
        first.message,
        { role: 'tool', toolCallId: call?.id ?? '', content: JSON.stringify({ count: 7 }) },
      ],
      tools,
      maxOutputTokens: 1024,
    });
    expect(second.finishReason).toBe('stop');
    expect(second.message.content).toContain('7');
  }, 90_000);
});
