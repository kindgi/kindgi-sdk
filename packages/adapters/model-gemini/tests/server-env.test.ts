// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Developer API provider stays on the Developer API, whatever the server's
 * environment says. Left to itself `@google/genai` switches to Vertex AI when
 * `GOOGLE_GENAI_USE_VERTEXAI` (or `GOOGLE_GENAI_USE_ENTERPRISE`) is set, with
 * the environment's project and location: the server's, not the provider's.
 * With the real SDK and those set to canaries, the request goes to the
 * Developer API with the provider's key. `GOOGLE_APPLICATION_CREDENTIALS` is
 * `/dev/null` throughout, so no credentials file on the machine is read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createGeminiProvider } from '../src/index.js';

const BASE_ENV = {
  GOOGLE_CLOUD_PROJECT: 'canary-server-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
  GOOGLE_APPLICATION_CREDENTIALS: '/dev/null',
} as const;
const SWITCHES = ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE'] as const;
const NAMES = [...Object.keys(BASE_ENV), ...SWITCHES];
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
beforeEach(() => {
  for (const name of NAMES) saved[name] = process.env[name];
  Object.assign(process.env, BASE_ENV);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const model = {
  name: 'gemini-2.5-flash',
  contextWindow: 1_000_000,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.0003, completionUsdPer1kTokens: 0.0025 },
} as const;

describe('a Developer API provider stays there', () => {
  for (const name of SWITCHES) {
    test(`with ${name}=true in the server's environment`, async () => {
      process.env[name] = 'true';
      const sent: { url: string; headers: Record<string, string> }[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(
          JSON.stringify({ error: { code: 400, message: 'stub', status: 'INVALID_ARGUMENT' } }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as typeof globalThis.fetch;
      const provider = createGeminiProvider({
        apiKey: async () => 'acme-tenant-gemini-key',
        metadata: { id: 'acme-gemini', region: 'unspecified', models: [model] },
      });
      await provider
        .invoke({ model: model.name, messages: [{ role: 'user', content: 'hi' }] })
        .catch(() => undefined);
      expect(sent.length).toBeGreaterThan(0);
      for (const request of sent) {
        expect(new URL(request.url).origin).toBe('https://generativelanguage.googleapis.com');
        expect(request.headers['x-goog-api-key']).toBe('acme-tenant-gemini-key');
      }
      expect(JSON.stringify(sent)).not.toContain('canary');
      expect(JSON.stringify(sent)).not.toContain('aiplatform');
    });
  }
});
