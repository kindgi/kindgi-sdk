// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { KindgiApiError } from '../src/errors.js';
import { createTransport } from '../src/transport.js';
import { errorFetch, jsonFetch, recordingFetch } from './support/recording-fetch.js';

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
