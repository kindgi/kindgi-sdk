// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Vertex side of the base-URL fix. `@google/genai` signs a Vertex call in
 * over a transport that doesn't go through `globalThis.fetch`, so a real call
 * can't be driven to a host offline (it would reach Google's token endpoint).
 * Instead this proves the adapter hands the SDK a concrete
 * `httpOptions.baseUrl` — the pinned Vertex host for the location — so
 * `GOOGLE_VERTEX_BASE_URL` in the server's environment is never read for it.
 * That the real SDK honours `httpOptions.baseUrl` over the environment is
 * proven on the Developer path in `server-env.test.ts`; `getBaseUrl` applies
 * the same `baseUrl`-set short-circuit for Vertex.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Replace only `GoogleGenAI` (keep the real types and enums the adapter imports):
// capture the options each construction gets, with a client that does no network.
const constructed: { vertexai?: boolean; httpOptions?: Record<string, unknown> }[] = [];
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAIStub {
    readonly models = {
      generateContent: () =>
        Promise.resolve({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
    };
    constructor(opts: { vertexai?: boolean; httpOptions?: Record<string, unknown> }) {
      constructed.push(opts);
    }
  }
  return { ...actual, GoogleGenAI: GoogleGenAIStub };
});

import { createGeminiProvider } from '../src/index.js';
import { vertexBaseUrl } from '../src/provider.js';

const model = {
  name: 'gemini-2.5-flash',
  contextWindow: 1_000_000,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.0003, completionUsdPer1kTokens: 0.0025 },
} as const;
const CANARY_BASE_URL = 'https://canary-base-url.invalid/v1';
const ENV_NAMES = ['GOOGLE_VERTEX_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  constructed.length = 0;
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/dev/null';
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('vertexBaseUrl mirrors the SDK host for a location', () => {
  test.each([
    ['global', 'https://aiplatform.googleapis.com/'],
    ['us', 'https://aiplatform.us.rep.googleapis.com/'],
    ['eu', 'https://aiplatform.eu.rep.googleapis.com/'],
    ['us-central1', 'https://us-central1-aiplatform.googleapis.com/'],
    ['northamerica-northeast1', 'https://northamerica-northeast1-aiplatform.googleapis.com/'],
  ])('%s → %s', (location, expected) => {
    expect(vertexBaseUrl(location)).toBe(expected);
  });
});

describe('the Vertex path pins httpOptions.baseUrl, ignoring GOOGLE_VERTEX_BASE_URL', () => {
  const CASES = [
    { location: 'global', host: 'https://aiplatform.googleapis.com/' },
    { location: 'us-central1', host: 'https://us-central1-aiplatform.googleapis.com/' },
    { location: 'us', host: 'https://aiplatform.us.rep.googleapis.com/' },
    { location: 'eu', host: 'https://aiplatform.eu.rep.googleapis.com/' },
  ] as const;
  for (const { location, host } of CASES) {
    test(`location "${location}" → ${host}`, async () => {
      process.env.GOOGLE_VERTEX_BASE_URL = CANARY_BASE_URL;
      const provider = createGeminiProvider({
        vertex: { project: 'acme-dev', location },
        metadata: { id: 'acme-gemini-vertex', region: 'unspecified', models: [model] },
      });
      await provider
        .invoke({ model: model.name, messages: [{ role: 'user', content: 'hi' }] })
        .catch(() => undefined);
      expect(constructed.length).toBeGreaterThan(0);
      const opts = constructed.at(-1);
      expect(opts?.vertexai).toBe(true);
      expect(opts?.httpOptions?.baseUrl).toBe(host);
      expect(String(opts?.httpOptions?.baseUrl)).not.toContain('canary-base-url');
      // The fix must not drop the counted fetch or the retry policy.
      expect(opts?.httpOptions?.fetch).toBeTypeOf('function');
      expect(opts?.httpOptions?.retryOptions).toBeDefined();
    });
  }
});
