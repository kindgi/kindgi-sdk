// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KindgiApiError } from '../src/errors.js';
import { createTransport } from '../src/transport.js';
import { errorFetch, hangingFetch, jsonFetch, recordingFetch } from './support/recording-fetch.js';

describe('createTransport', () => {
  it('strips trailing slash from apiUrl before path join', async () => {
    const stub = jsonFetch({ ok: true });
    const transport = createTransport({
      apiUrl: 'https://api.example.com///',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: stub.fetch,
    });
    await transport.request({ method: 'GET', path: '/v1/health' });
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/health');
  });

  it('serializes query params and drops undefined values', async () => {
    const stub = jsonFetch({ ok: true });
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: stub.fetch,
    });
    await transport.request({
      method: 'GET',
      path: '/v1/agents',
      query: { limit: 10, name: 'foo', skipped: undefined },
    });
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('name')).toBe('foo');
    expect(url.searchParams.has('skipped')).toBe(false);
  });

  it('repeats the key for an array value, in order', async () => {
    const stub = jsonFetch({ ok: true });
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: stub.fetch,
    });
    await transport.request({
      method: 'GET',
      path: '/v1/agents/a/live',
      query: { segment: ['company:acme', 'role:counsel'], empty: [] },
    });
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.getAll('segment')).toEqual(['company:acme', 'role:counsel']);
    expect(url.searchParams.has('empty')).toBe(false);
  });

  it("an authorizer's 403 is a forbidden auth error", async () => {
    const stub = errorFetch(403, {
      code: 'permission-denied',
      message: 'Permission denied: actor user:u-1 does not have can_read on agent:acme.drafter',
      details: { action: 'read', resource: 'agent:acme.drafter', reason: 'no can_read' },
    });
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: stub.fetch,
    });
    const thrown = await transport
      .request({ method: 'GET', path: '/v1/agents/acme.drafter' })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(KindgiApiError);
    expect((thrown as KindgiApiError).error).toMatchObject({ code: 'auth', reason: 'forbidden' });
  });

  it('passes Authorization Bearer for oauth kind too', async () => {
    const stub = jsonFetch({ ok: true });
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'oauth', accessToken: 'oauth-x' },
      fetch: stub.fetch,
    });
    await transport.request({ method: 'GET', path: '/v1/whoami' });
    expect(stub.calls[0]?.headers.authorization).toBe('Bearer oauth-x');
  });

  it('returns undefined and consumes body for discardResponse', async () => {
    const stub = jsonFetch({ irrelevant: true });
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: stub.fetch,
    });
    const out = await transport.request({
      method: 'POST',
      path: '/v1/runs/cancel',
      discardResponse: true,
    });
    expect(out).toBeUndefined();
  });

  it('hydrates wire error envelope to KindgiError via fromWire', async () => {
    const stub = errorFetch(400, {
      code: 'validation-failed',
      message: 'bad body',
      details: { issues: [{ path: '/id', message: 'missing' }] },
    });
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: stub.fetch,
    });
    try {
      await transport.request({ method: 'POST', path: '/v1/agents', body: {} });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KindgiApiError);
      expect((e as KindgiApiError).error).toMatchObject({
        code: 'invalid-request',
        issues: [{ path: '/id', message: 'missing' }],
      });
    }
  });

  it('produces NetworkError on fetch throw', async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error('DNS blew up');
    };
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: failingFetch,
    });
    await expect(transport.request({ method: 'GET', path: '/v1/anything' })).rejects.toMatchObject({
      error: { code: 'network', message: 'DNS blew up' },
    });
  });

  it('does not send Idempotency-Key on GET even when supplied', async () => {
    const stub = recordingFetch([{ status: 200, body: '{}' }]);
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 'tk' },
      fetch: stub.fetch,
    });
    await transport.request({
      method: 'GET',
      path: '/v1/agents',
      idempotencyKey: 'idem-nope',
    });
    expect(stub.calls[0]?.headers['idempotency-key']).toBeUndefined();
  });
});

describe('createTransport: the timeout', () => {
  const AUTH = { kind: 'apiToken' as const, token: 'tk' };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The error a request ends with. */
  async function failure(promise: Promise<unknown>): Promise<KindgiApiError> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(KindgiApiError);
    return error as KindgiApiError;
  }

  it('is 30 s by default: a network error that names it', async () => {
    vi.useFakeTimers();
    const stub = hangingFetch();
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    let settled = false;
    const request = transport.request({ method: 'GET', path: '/v1/health' });
    request
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await failure(request);
    expect(e.error).toMatchObject({
      code: 'network',
      timeoutMs: 30_000,
      message: "No answer within 30 s, the client's timeout (timeoutMs).",
    });
  });

  it('ClientOptions.timeoutMs sets it for every request', async () => {
    const stub = hangingFetch();
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
      timeoutMs: 20,
    });
    const e = await failure(transport.request({ method: 'GET', path: '/v1/health' }));
    expect(e.error).toMatchObject({ code: 'network', timeoutMs: 20 });
    expect(e.message).toBe("No answer within 0.02 s, the client's timeout (timeoutMs).");
  });

  it("a request's own timeoutMs wins over the client's", async () => {
    const stub = hangingFetch();
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
      timeoutMs: 60_000,
    });
    const e = await failure(
      transport.request({ method: 'GET', path: '/v1/health', timeoutMs: 15 }),
    );
    expect(e.error).toMatchObject({ code: 'network', timeoutMs: 15 });
  });

  it('a timeout that is not a positive number of milliseconds is refused', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createTransport({ apiUrl: 'https://api.example.com', auth: AUTH, timeoutMs }),
      ).toThrow(
        `ClientOptions.timeoutMs must be a positive number of milliseconds. Got ${timeoutMs}.`,
      );
    }
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: hangingFetch().fetch,
    });
    await expect(
      transport.request({ method: 'GET', path: '/v1/health', timeoutMs: 0 }),
    ).rejects.toThrow('timeoutMs must be a positive number of milliseconds. Got 0.');
  });

  it("a network failure that isn't the timeout carries no timeoutMs", async () => {
    const transport = createTransport({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: async () => {
        throw new Error('connection refused');
      },
    });
    const e = await failure(transport.request({ method: 'GET', path: '/v1/health' }));
    expect(e.error).toEqual(
      expect.objectContaining({ code: 'network', message: 'connection refused' }),
    );
    expect(e.error).not.toHaveProperty('timeoutMs');
  });
});
