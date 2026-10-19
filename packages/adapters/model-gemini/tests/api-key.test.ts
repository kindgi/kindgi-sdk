// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Gemini on the Developer API, with an API key (Google AI Studio), next to
 * Vertex AI. The SDK class is replaced by one that records the options it
 * was built with and answers, so no Google credentials or network are
 * needed.
 */

import type { GenerateContentResponse, GoogleGenAIOptions } from '@google/genai';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type GeminiProviderOptions,
  createGeminiProvider,
  geminiAdapterFactory,
} from '../src/index.js';

const built: GoogleGenAIOptions[] = [];

vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    readonly models = {
      async generateContent(): Promise<GenerateContentResponse> {
        return {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        } as GenerateContentResponse;
      },
    };
    constructor(options: GoogleGenAIOptions) {
      built.push(options);
    }
  },
}));

beforeEach(() => {
  built.length = 0;
});

const METADATA: GeminiProviderOptions['metadata'] = {
  id: 'gemini-api',
  region: 'unspecified',
  models: [
    {
      name: 'gemini-3.8-flash',
      contextWindow: 1_048_576,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
    },
  ],
};

const call = (provider: ReturnType<typeof createGeminiProvider>) =>
  provider.invoke({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] });

describe('createGeminiProvider with a Gemini API key', () => {
  test('the client is the Developer API one, with the key; a rotated key rebuilds it', async () => {
    let key = 'key-1';
    const provider = createGeminiProvider({ metadata: METADATA, apiKey: () => key });
    expect((await call(provider)).message.content).toBe('done');
    await call(provider);
    key = 'key-2';
    await call(provider);
    expect(built.map((o) => o.apiKey)).toEqual(['key-1', 'key-2']);
    // Said outright, so the server's GOOGLE_GENAI_USE_VERTEXAI can't move it (tests/server-env.test.ts).
    expect(built[0]?.vertexai).toBe(false);
    expect(built[0]?.project).toBeUndefined();
    expect(built[0]?.httpOptions?.fetch).toBeTypeOf('function');
  });

  test('keys taking turns (a run in each of two projects, each with its own key): one client each, reused', async () => {
    const keys = ['key-a', 'key-b', 'key-a', 'key-b'];
    const provider = createGeminiProvider({
      metadata: METADATA,
      apiKey: () => keys.shift() ?? 'key-x',
    });
    for (let i = 0; i < 4; i++) await call(provider);
    expect(built.map((o) => o.apiKey)).toEqual(['key-a', 'key-b']);
  });

  test('an empty key fails the call, naming the provider', async () => {
    const provider = createGeminiProvider({ metadata: METADATA, apiKey: () => '  ' });
    await expect(call(provider)).rejects.toThrow(
      'provider "gemini-api"\'s Gemini API key is empty',
    );
  });

  test('exactly one target: Vertex AI or an API key', () => {
    expect(() => createGeminiProvider({ metadata: METADATA })).toThrow(
      'needs exactly one of vertex (a Vertex AI project) or apiKey (a Gemini Developer API key)',
    );
    expect(() =>
      createGeminiProvider({
        metadata: METADATA,
        apiKey: () => 'k',
        vertex: { project: 'acme-dev', location: 'global' },
      }),
    ).toThrow('needs exactly one of');
  });
});

describe('createGeminiProvider on Vertex AI with a service-account key', () => {
  test('keys taking turns: one client each, reused, each with its own key', async () => {
    const saKey = (email: string) =>
      JSON.stringify({ type: 'service_account', client_email: email, private_key: 'pk' });
    const keys = ['a@acme.example', 'b@acme.example', 'a@acme.example', 'b@acme.example'];
    const provider = createGeminiProvider({
      metadata: METADATA,
      vertex: { project: 'acme-dev', location: 'global' },
      credentials: () => saKey(keys.shift() ?? 'x@acme.example'),
    });
    for (let i = 0; i < 4; i++) await call(provider);
    expect(
      built.map(
        (o) => (o.googleAuthOptions?.credentials as { client_email?: string })?.client_email,
      ),
    ).toEqual(['a@acme.example', 'b@acme.example']);
  });
});

describe('geminiAdapterFactory: adapter_config.api', () => {
  const input = (config: Record<string, unknown> | undefined, withKey: boolean) =>
    ({
      metadata: METADATA,
      ...(config !== undefined && { config }),
      ...(withKey && { resolveApiKey: async () => 'key-from-the-secret' }),
    }) as Parameters<typeof geminiAdapterFactory>[0];

  test('"developer": the Gemini Developer API with the secret as its key, no project needed', async () => {
    const provider = geminiAdapterFactory(input({ api: 'developer' }, true));
    await call(provider);
    expect(built[0]?.apiKey).toBe('key-from-the-secret');
    // Said outright, so the server's GOOGLE_GENAI_USE_VERTEXAI can't move it (tests/server-env.test.ts).
    expect(built[0]?.vertexai).toBe(false);
  });

  test('"developer" without a secret_ref is refused', () => {
    expect(() => geminiAdapterFactory(input({ api: 'developer' }, false))).toThrow(
      'needs secret_ref: its Gemini API key',
    );
  });

  test('no api is Vertex, as before (it needs the project); another value is refused', async () => {
    expect(() => geminiAdapterFactory(input(undefined, false))).toThrow(
      'needs adapter_config.project',
    );
    const vertex = geminiAdapterFactory(input({ project: 'acme-dev' }, false));
    await call(vertex);
    expect(built[0]).toMatchObject({ vertexai: true, project: 'acme-dev', location: 'global' });
    expect(() => geminiAdapterFactory(input({ api: 'studio' }, true))).toThrow(
      'adapter_config.api must be "vertex" or "developer", got "studio"',
    );
  });
});
