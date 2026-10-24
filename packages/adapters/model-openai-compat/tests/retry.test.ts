// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The adapter owns the retry policy on every call path (chat, responses,
 * embeddings). A connection the runtime refuses the same way every time — an
 * egress or body-size guard, a redirect — is tried once and its own words reach
 * the caller, not the OpenAI SDK's "Connection error."; a transient failure
 * (429, 5xx, a dropped connection) is retried up to the caller's budget.
 */

import { describe, expect, test } from 'vitest';

import { ModelProviderError } from '@kindgi/adapter-model-shared';

import {
  createOpenAICompatEmbeddingProvider,
  createOpenAICompatModelProvider,
} from '../src/index.js';

const BASE = 'http://llm.acme.test/v1';
const metadata = {
  id: 'acme-compat',
  region: 'local',
  models: [
    {
      name: 'gpt-test',
      contextWindow: 128000,
      features: ['tool-use'] as const,
      cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
    },
  ],
};
const call = { model: 'gpt-test', messages: [{ role: 'user' as const, content: 'hi' }] };
const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

type Outcome =
  | { readonly throw: Error }
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> };

/** A fetch that plays `outcomes` in order (the last repeats) and records every request. */
function scripted(outcomes: readonly Outcome[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly seen: number[];
} {
  const seen: number[] = [];
  const fetch = (async (_input: unknown, _init?: unknown): Promise<Response> => {
    const outcome = outcomes[Math.min(seen.length, outcomes.length - 1)] as Outcome;
    seen.push(seen.length);
    if ('throw' in outcome) throw outcome.throw;
    return new Response(outcome.body === undefined ? '{}' : JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'content-type': 'application/json', ...(outcome.headers ?? {}) },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

/** An error as the runtime's guard throws it from the injected fetch: a message and a system code. */
function guard(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function chat(fetch: typeof globalThis.fetch, maxRetries?: number) {
  return createOpenAICompatModelProvider({
    baseURL: BASE,
    apiKey: 'sk-test',
    metadata,
    api: 'chat-completions',
    clientOptions: { fetch, ...(maxRetries !== undefined && { maxRetries }) },
  });
}
function responses(fetch: typeof globalThis.fetch) {
  return createOpenAICompatModelProvider({
    baseURL: BASE,
    apiKey: 'sk-test',
    metadata,
    api: 'responses',
    clientOptions: { fetch },
  });
}
function embeddings(fetch: typeof globalThis.fetch) {
  return createOpenAICompatEmbeddingProvider({
    baseURL: BASE,
    model: 'acme-embed',
    apiKey: 'sk-test',
    clientOptions: { fetch },
  });
}

/** Run a promise to its rejection, or fail the test if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error,
  );
}

const RATE_429 = {
  status: 429,
  body: { error: { message: 'slow down' } },
  headers: { 'retry-after-ms': '0' },
} as const;
const BUSY_503 = {
  status: 503,
  body: { error: { message: 'overloaded' } },
  headers: { 'retry-after-ms': '0' },
} as const;

describe('a connection the runtime refuses is tried once, its own words on top', () => {
  const refusals = [
    [
      'EKINDGIEGRESS',
      'egress refused: 169.254.169.254 is link-local, which this deployment forbids',
    ],
    ['EKINDGIBODY', 'the request body of 12 MiB is over the 8 MiB this deployment allows'],
  ] as const;

  for (const [code, message] of refusals) {
    test(`chat — ${code}`, async () => {
      const endpoint = scripted([{ throw: guard(code, message) }]);
      const error = await rejection(chat(endpoint.fetch).invoke(call));
      expect(endpoint.seen).toHaveLength(1);
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as ModelProviderError).kind).toBe('network');
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain('Connection error');
    });

    test(`responses — ${code}`, async () => {
      const endpoint = scripted([{ throw: guard(code, message) }]);
      const error = await rejection(responses(endpoint.fetch).invoke(call));
      expect(endpoint.seen).toHaveLength(1);
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as ModelProviderError).kind).toBe('network');
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain('Connection error');
    });

    test(`embeddings — ${code}`, async () => {
      const endpoint = scripted([{ throw: guard(code, message) }]);
      const error = await rejection(embeddings(endpoint.fetch).embed('hi'));
      expect(endpoint.seen).toHaveLength(1);
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as ModelProviderError).kind).toBe('network');
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain('Connection error');
    });
  }

  test('a redirect the request will not follow is tried once', async () => {
    // The OpenAI SDK rejects a redirect with "unexpected redirect" on the cause chain.
    const endpoint = scripted([{ throw: new Error('unexpected redirect') }]);
    const error = await rejection(chat(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(1);
    expect((error as ModelProviderError).kind).toBe('unavailable');
    expect((error as Error).message).toContain("isn't followed");
  });
});

describe('a transient failure is retried, then the call succeeds', () => {
  test('a 429', async () => {
    const endpoint = scripted([RATE_429, { status: 200, body: COMPLETION }]);
    const result = await chat(endpoint.fetch).invoke(call);
    expect(endpoint.seen).toHaveLength(2);
    expect(result.message.content).toBe('ok');
    expect(result.attempts).toBe(2);
  });

  test('a 5xx', async () => {
    const endpoint = scripted([BUSY_503, { status: 200, body: COMPLETION }]);
    const result = await chat(endpoint.fetch).invoke(call);
    expect(endpoint.seen).toHaveLength(2);
    expect(result.message.content).toBe('ok');
  });

  test('a dropped connection', async () => {
    const endpoint = scripted([
      { throw: new TypeError('fetch failed') },
      { status: 200, body: COMPLETION },
    ]);
    const result = await chat(endpoint.fetch, 1).invoke(call);
    expect(endpoint.seen).toHaveLength(2);
    expect(result.message.content).toBe('ok');
  });
});

describe('every call path retries a transient failure up to the attempt budget', () => {
  test('chat — a 429 that never clears is tried the budget (default 3), then fails rate-limited', async () => {
    const endpoint = scripted([RATE_429]);
    const error = await rejection(chat(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(3);
    expect((error as ModelProviderError).kind).toBe('rate-limited');
    expect((error as ModelProviderError).status).toBe(429);
  });

  test('responses — a 429 that never clears is tried the budget', async () => {
    const endpoint = scripted([RATE_429]);
    const error = await rejection(responses(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(3);
    expect((error as ModelProviderError).kind).toBe('rate-limited');
  });

  test('embeddings — a 429 that never clears is tried the budget', async () => {
    const endpoint = scripted([RATE_429]);
    const error = await rejection(embeddings(endpoint.fetch).embed('hi'));
    expect(endpoint.seen).toHaveLength(3);
    expect((error as ModelProviderError).kind).toBe('rate-limited');
  });
});

describe("the caller's maxRetries sets the attempt budget", () => {
  test('maxRetries: 0 — one attempt, no retry', async () => {
    const endpoint = scripted([RATE_429]);
    const error = await rejection(chat(endpoint.fetch, 0).invoke(call));
    expect(endpoint.seen).toHaveLength(1);
    expect((error as ModelProviderError).kind).toBe('rate-limited');
  });

  test('maxRetries: 4 — five attempts in all', async () => {
    const endpoint = scripted([BUSY_503]);
    const error = await rejection(chat(endpoint.fetch, 4).invoke(call));
    expect(endpoint.seen).toHaveLength(5);
    expect((error as ModelProviderError).kind).toBe('unavailable');
  });
});

describe('the vendor can ask for a wait too long to sit through', () => {
  test('a retry-after past the limit ends the call at once, naming the wait', async () => {
    const endpoint = scripted([
      { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '120' } },
    ]);
    const error = await rejection(chat(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(1);
    expect((error as ModelProviderError).kind).toBe('rate-limited');
    expect((error as Error).message).toContain('120 s');
  });
});

describe("a vendor's x-should-retry overrides the status", () => {
  test('x-should-retry: false on a 429 is not retried', async () => {
    const endpoint = scripted([
      {
        status: 429,
        body: { error: { message: 'slow down' } },
        headers: { 'x-should-retry': 'false' },
      },
    ]);
    const error = await rejection(chat(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(1);
    expect((error as ModelProviderError).kind).toBe('rate-limited');
    expect((error as ModelProviderError).status).toBe(429);
  });

  test('x-should-retry: true on a 400 is retried to the budget', async () => {
    const endpoint = scripted([
      {
        status: 400,
        body: { error: { message: 'odd' } },
        headers: { 'x-should-retry': 'true', 'retry-after-ms': '0' },
      },
    ]);
    const error = await rejection(chat(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(3);
    expect((error as ModelProviderError).kind).toBe('invalid-request');
    expect((error as ModelProviderError).status).toBe(400);
  });
});

describe('a failure the status alone decides', () => {
  test('a 400 is tried once, invalid-request, its words after the status', async () => {
    const endpoint = scripted([{ status: 400, body: { error: { message: 'bad field "foo"' } } }]);
    const error = await rejection(chat(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(1);
    expect((error as ModelProviderError).kind).toBe('invalid-request');
    expect((error as ModelProviderError).status).toBe(400);
    expect((error as Error).message).toBe('400 bad field "foo"');
  });

  test('a 401 is tried once, auth', async () => {
    const endpoint = scripted([{ status: 401, body: { error: { message: 'bad key' } } }]);
    const error = await rejection(chat(endpoint.fetch).invoke(call));
    expect(endpoint.seen).toHaveLength(1);
    expect((error as ModelProviderError).kind).toBe('auth');
    expect((error as ModelProviderError).status).toBe(401);
  });

  test('a 409 is retried, then the call succeeds', async () => {
    const endpoint = scripted([
      {
        status: 409,
        body: { error: { message: 'lock timeout' } },
        headers: { 'retry-after-ms': '0' },
      },
      { status: 200, body: COMPLETION },
    ]);
    const result = await chat(endpoint.fetch).invoke(call);
    expect(endpoint.seen).toHaveLength(2);
    expect(result.message.content).toBe('ok');
  });
});

describe('an abort observed after a failed attempt ends the call at once', () => {
  test('a 429, then an already-aborted signal: one request, the turn reason', async () => {
    const controller = new AbortController();
    const reason = new Error('turn cancelled');
    const seen: number[] = [];
    const fetch = (async (): Promise<Response> => {
      seen.push(seen.length);
      if (seen.length === 1) {
        // Queue the abort on a microtask so it lands while this 429 is read,
        // before the inter-attempt wait. `withRetries` sees it in its
        // `stopped()` check right after the failed attempt and ends the call;
        // that it ends at all proves the signal reached `sendWithRetries` (a
        // dropped signal would retry). model-shared pins the abortable wait.
        queueMicrotask(() => controller.abort(reason));
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '30000' },
        });
      }
      throw new Error('a second request should not be sent after the abort');
    }) as typeof globalThis.fetch;
    const error = await rejection(chat(fetch).invoke({ ...call, abortSignal: controller.signal }));
    expect(seen).toHaveLength(1);
    expect(error).toBe(reason);
  });
});
