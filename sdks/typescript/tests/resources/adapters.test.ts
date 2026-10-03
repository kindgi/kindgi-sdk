// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_ADAPTER = {
  adapterId: 'model-anthropic',
  kind: 'model' as const,
  name: '@kindgi/adapter-model-anthropic',
  version: '1.2.3',
  capabilities: ['tool-use', 'streaming'],
  status: 'active' as const,
};

describe('adapters.list', () => {
  it('GETs /v1/adapters with kind/status filters', async () => {
    const stub = jsonFetch({ data: [WIRE_ADAPTER], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.adapters.list({ kind: 'model', status: 'active' });
    expect(page.items[0]?.adapterId).toBe('model-anthropic');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('kind')).toBe('model');
    expect(url.searchParams.get('status')).toBe('active');
  });
});

describe('adapters.get', () => {
  it('GETs /v1/adapters/{adapterId}', async () => {
    const stub = jsonFetch(WIRE_ADAPTER);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const a = await client.adapters.get('model-anthropic');
    expect(a.status).toBe('active');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/adapters/model-anthropic');
  });
});

describe('adapters.test', () => {
  it('POSTs /v1/adapters/{adapterId}/test with probe body + Idempotency-Key', async () => {
    const stub = jsonFetch({ ok: true, latencyMs: 42, probe: { detail: 'ok' } });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const outcome = await client.adapters.test({
      adapterId: 'model-anthropic',
      probe: { prompt: 'ping' },
      idempotencyKey: 'idem-x',
    });

    expect(outcome.ok).toBe(true);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/adapters/model-anthropic/test');
    expect(req.headers['idempotency-key']).toBe('idem-x');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ prompt: 'ping' });
  });

  it('POSTs an empty object when no probe payload is supplied', async () => {
    const stub = jsonFetch({ ok: false, latencyMs: 0, probe: {} });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.adapters.test({ adapterId: 'sandbox-inprocess' });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({});
  });
});

describe('adapters not-yet-wired surface', () => {
  it('candidates / configured / configure all throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.adapters.candidates()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'adapters.candidates' },
    });
    await expect(client.adapters.configured()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'adapters.configured' },
    });
    await expect(
      client.adapters.configure({ kind: 'model', vendor: 'anthropic', config: {} }),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'adapters.configure' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
