// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Nothing of the server's environment goes out with a provider's calls. Left
 * to itself the Anthropic SDK reads `ANTHROPIC_AUTH_TOKEN` (and sends it as a
 * bearer beside the provider's own key) and `ANTHROPIC_BASE_URL`. With both
 * set to canaries, the request the provider sends carries neither.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createAnthropicProvider } from '../src/index.js';

const SERVER_ENV = {
  ANTHROPIC_AUTH_TOKEN: 'canary-server-auth-token',
  ANTHROPIC_BASE_URL: 'http://canary-server-base.invalid',
} as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [name, value] of Object.entries(SERVER_ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const name of Object.keys(SERVER_ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const model = {
  name: 'claude-sonnet-4-6',
  contextWindow: 200_000,
  features: ['tool-use'],
  cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
} as const;
const call = { model: model.name, messages: [{ role: 'user' as const, content: 'hi' }] };

/** A fetch that records each request and answers 400, so the call ends there. */
function capture() {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stub' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

describe("the server's environment stays out of a provider's calls", () => {
  for (const baseURL of [undefined, 'https://llm-gateway.acme.example']) {
    test(`${baseURL === undefined ? "no baseURL: Anthropic's own API" : 'a baseURL: that one'}, the provider's key, no bearer`, async () => {
      const { sent, fetch } = capture();
      const provider = createAnthropicProvider({
        apiKey: 'sk-ant-acme-tenant',
        ...(baseURL !== undefined && { baseURL }),
        metadata: { id: 'acme-claude', region: 'us-east-1', models: [model] },
        clientOptions: { fetch, maxRetries: 0 },
      });
      await provider.invoke(call).catch(() => undefined);
      expect(sent).toHaveLength(1);
      expect(new URL(sent[0]?.url ?? '').origin).toBe(baseURL ?? 'https://api.anthropic.com');
      expect(sent[0]?.headers['x-api-key']).toBe('sk-ant-acme-tenant');
      expect(sent[0]?.headers.authorization).toBeUndefined();
      expect(JSON.stringify(sent)).not.toContain('canary');
    });
  }
});
