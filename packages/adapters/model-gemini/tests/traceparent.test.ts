// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `ModelCallInput.traceparent`: the real `@google/genai` client sends it as
 * a header on the call's request when the call carries one (the caller
 * sets it only for a provider whose registration opts in), and never in
 * the body.
 */

import { afterEach, describe, expect, test } from 'vitest';

import { createGeminiProvider } from '../src/index.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const METADATA = {
  id: 'gemini-api',
  region: 'global',
  models: [
    {
      name: 'gemini-2.5-pro',
      contextWindow: 1_048_576,
      features: [],
      cost: { promptUsdPer1kTokens: 0.00125, completionUsdPer1kTokens: 0.01 },
    },
  ],
};

interface Sent {
  readonly traceparent: string | null;
  readonly body: string;
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/** Answers each request, recording its traceparent header and body. */
function vendor(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    sent.push({
      traceparent: new Headers(init?.headers).get('traceparent'),
      body: String(init?.body),
    });
    return Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
  };
  return sent;
}

describe('createGeminiProvider: traceparent', () => {
  const provider = () => createGeminiProvider({ metadata: METADATA, apiKey: () => 'k' });
  const call = { model: 'gemini-2.5-pro', messages: [{ role: 'user' as const, content: 'hi' }] };

  test('a call with a traceparent sends it as a header, never in the body', async () => {
    const sent = vendor();
    await provider().invoke({ ...call, traceparent: TRACEPARENT });
    expect(sent.map((s) => s.traceparent)).toEqual([TRACEPARENT]);
    expect(sent.every((s) => !s.body.includes(TRACEPARENT))).toBe(true);
    expect(sent.every((s) => !s.body.includes('traceparent'))).toBe(true);
  });

  test('a call without one sends none', async () => {
    const sent = vendor();
    await provider().invoke(call);
    expect(sent.map((s) => s.traceparent)).toEqual([null]);
  });
});
