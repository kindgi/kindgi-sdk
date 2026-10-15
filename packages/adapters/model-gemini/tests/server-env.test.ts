// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Developer API provider's calls stay on the Developer API, at its own host,
 * whatever the server's environment says. Two ways the environment could move
 * them, both covered here against the REAL `@google/genai`:
 *
 *   - `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_ENTERPRISE` switch the
 *     provider to Vertex AI (the server's project and credentials). The
 *     adapter gives `vertexai: false`, so it can't.
 *   - `GOOGLE_GEMINI_BASE_URL` moves the request's host: `@google/genai`'s
 *     `getBaseUrl` reads it when no `httpOptions.baseUrl` is given, so one
 *     operator variable would send every tenant's calls, with the tenant's
 *     key, to that URL. The adapter gives `baseUrl`, so it can't.
 *
 * A Developer API call carries its key in a header and needs no token
 * exchange, so the whole request is observable through a stubbed `fetch`. The
 * Vertex side of the base-URL fix (`GOOGLE_VERTEX_BASE_URL`) is proven in
 * `vertex-base-url.test.ts`: Vertex signs in over a transport that doesn't go
 * through `globalThis.fetch`, so it can't be driven to the host offline; that
 * file checks the adapter hands the SDK the pinned `baseUrl` instead.
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` is `/dev/null` throughout, so no
 * credentials file on the machine is read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createGeminiProvider } from '../src/index.js';

const BASE_ENV = {
  GOOGLE_CLOUD_PROJECT: 'canary-server-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
  GOOGLE_APPLICATION_CREDENTIALS: '/dev/null',
} as const;
const SWITCHES = ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE'] as const;
const CANARY_BASE_URL = 'https://canary-base-url.invalid/v1';
const NAMES = [...Object.keys(BASE_ENV), ...SWITCHES, 'GOOGLE_GEMINI_BASE_URL'];
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

/** Records every request and answers it with a stub, so none leaves the process. */
function recordingFetch(sent: { url: string; headers: Record<string, string> }[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(
      JSON.stringify({ error: { code: 400, message: 'stub', status: 'INVALID_ARGUMENT' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
}

async function invokeDeveloper(): Promise<{ url: string; headers: Record<string, string> }[]> {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = recordingFetch(sent);
  const provider = createGeminiProvider({
    apiKey: async () => 'acme-tenant-gemini-key',
    metadata: { id: 'acme-gemini', region: 'unspecified', models: [model] },
  });
  await provider
    .invoke({ model: model.name, messages: [{ role: 'user', content: 'hi' }] })
    .catch(() => undefined);
  return sent;
}

describe('a Developer API provider stays there', () => {
  for (const name of SWITCHES) {
    test(`with ${name}=true in the server's environment`, async () => {
      process.env[name] = 'true';
      const sent = await invokeDeveloper();
      expect(sent.length).toBeGreaterThan(0);
      for (const request of sent) {
        expect(new URL(request.url).origin).toBe('https://generativelanguage.googleapis.com');
        expect(request.headers['x-goog-api-key']).toBe('acme-tenant-gemini-key');
      }
      expect(JSON.stringify(sent)).not.toContain('canary');
      expect(JSON.stringify(sent)).not.toContain('aiplatform');
    });
  }

  test('GOOGLE_GEMINI_BASE_URL in the server environment never moves the call', async () => {
    process.env.GOOGLE_GEMINI_BASE_URL = CANARY_BASE_URL;
    const sent = await invokeDeveloper();
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(new URL(request.url).origin).toBe('https://generativelanguage.googleapis.com');
      expect(request.headers['x-goog-api-key']).toBe('acme-tenant-gemini-key');
    }
    expect(JSON.stringify(sent)).not.toContain('canary-base-url');
  });
});
