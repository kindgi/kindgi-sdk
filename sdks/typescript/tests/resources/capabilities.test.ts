// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_CAPABILITY = {
  id: 'feature:tool-use',
  feature: 'tool-use',
  description: 'Model supports tool/function calling.',
};

const WIRE_PROVIDER = {
  id: 'anthropic-eu',
  model: 'anthropic/claude-opus-4-7@2026-06-01',
  region: 'eu-west',
  contextWindow: 200_000,
  features: ['tool-use', 'long-context'],
  cost: { promptUsdPer1kTokens: 15, completionUsdPer1kTokens: 75 },
};

describe('capabilities.list', () => {
  it('GETs /v1/capabilities with feature filter', async () => {
    const stub = jsonFetch({ data: [WIRE_CAPABILITY], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.capabilities.list({ feature: 'tool-use', limit: 10 });
    expect(page.items[0]?.feature).toBe('tool-use');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('feature')).toBe('tool-use');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});

describe('capabilities.providers.list / get / configure / capabilitiesFor / delete', () => {
  it('GETs /v1/providers with feature filter', async () => {
    const stub = jsonFetch({ data: [WIRE_PROVIDER], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.capabilities.providers.list({ feature: 'tool-use' });
    expect(page.items[0]?.id).toBe('anthropic-eu');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('feature')).toBe('tool-use');
  });

  it('GETs /v1/providers/{id}', async () => {
    const stub = jsonFetch(WIRE_PROVIDER);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const p = await client.capabilities.providers.get('anthropic-eu');
    expect(p.model).toBe('anthropic/claude-opus-4-7@2026-06-01');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/providers/anthropic-eu');
  });

  it('POSTs /v1/providers with idempotency key', async () => {
    const stub = jsonFetch({ providerId: 'anthropic-eu' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.capabilities.providers.configure(WIRE_PROVIDER, {
      idempotencyKey: 'idem-prov',
    });
    expect(result.providerId).toBe('anthropic-eu');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers['idempotency-key']).toBe('idem-prov');
    expect(JSON.parse(req.body ?? '{}').model).toBe('anthropic/claude-opus-4-7@2026-06-01');
  });

  it('GETs /v1/providers/{id}/capabilities and unwraps `{ data: [...] }` envelope', async () => {
    const stub = jsonFetch({ data: [WIRE_CAPABILITY] });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const caps = await client.capabilities.providers.capabilitiesFor('anthropic-eu');
    expect(caps).toHaveLength(1);
    expect(caps[0]?.feature).toBe('tool-use');
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/providers/anthropic-eu/capabilities',
    );
  });

  it('POSTs /v1/providers/{id}/unregister on delete', async () => {
    const stub = jsonFetch({ providerId: 'anthropic-eu', unregistered: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.capabilities.providers.delete('anthropic-eu');
    expect(result.unregistered).toBe(true);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/providers/anthropic-eu/unregister');
  });

  it('maps 404 provider-not-found onto not-found', async () => {
    const stub = errorFetch(404, { code: 'provider-not-found', message: 'no such provider' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.capabilities.providers.get('nope')).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('capabilities not-yet-wired surface', () => {
  it('route / providers.enable / providers.disable throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.capabilities.route([{ feature: 'tool-use' }])).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'capabilities.route' },
    });
    await expect(client.capabilities.providers.enable('anthropic-eu')).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'capabilities.providers.enable' },
    });
    await expect(client.capabilities.providers.disable('anthropic-eu')).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'capabilities.providers.disable' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
