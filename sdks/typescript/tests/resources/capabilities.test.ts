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

// The provider as `/v1/providers` sends it: its models under `models[]`.
const WIRE_PROVIDER = {
  id: 'acme-eu',
  region: 'eu-west',
  models: [
    {
      name: 'acme-llm/acme-large',
      contextWindow: 200_000,
      features: ['tool-use', 'long-context'],
      cost: { promptUsdPer1kTokens: 15, completionUsdPer1kTokens: 75 },
    },
  ],
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
    expect(page.data[0]?.feature).toBe('tool-use');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('feature')).toBe('tool-use');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});

describe('capabilities.providers (deprecated): the calls of client.providers', () => {
  it('GETs /v1/providers with feature filter, answering the providers as sent', async () => {
    const stub = jsonFetch({ data: [WIRE_PROVIDER], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.capabilities.providers.list({ feature: 'tool-use', limit: 10 });
    expect(page.data[0]?.id).toBe('acme-eu');
    expect(page.data[0]?.models[0]?.name).toBe('acme-llm/acme-large');
    expect(page.hasMore).toBe(false);
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/providers');
    expect(url.searchParams.get('feature')).toBe('tool-use');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('GETs /v1/providers/{id}, with the models under models[]', async () => {
    const stub = jsonFetch(WIRE_PROVIDER);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const p = await client.capabilities.providers.get('acme-eu');
    expect(p).toEqual(WIRE_PROVIDER);
    expect(p.models[0]?.features).toEqual(['tool-use', 'long-context']);
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/providers/acme-eu');
  });

  it('configure POSTs the register body to /v1/providers with idempotency key', async () => {
    const stub = jsonFetch({ providerId: 'acme-eu' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const body = { metadata: WIRE_PROVIDER, adapter_id: '@acme/adapter-model' };
    const result = await client.capabilities.providers.configure(body, {
      idempotencyKey: 'idem-prov',
    });
    expect(result.providerId).toBe('acme-eu');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/providers');
    expect(req.headers['idempotency-key']).toBe('idem-prov');
    expect(JSON.parse(req.body ?? '{}')).toEqual(body);
  });

  it('GETs /v1/providers/{id}/capabilities and unwraps `{ data: [...] }` envelope', async () => {
    const stub = jsonFetch({ data: [WIRE_CAPABILITY] });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const caps = await client.capabilities.providers.capabilitiesFor('acme-eu');
    expect(caps).toHaveLength(1);
    expect(caps[0]?.feature).toBe('tool-use');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/providers/acme-eu/capabilities');
  });

  it('delete POSTs /v1/providers/{id}/unregister with no body', async () => {
    const stub = jsonFetch({ providerId: 'acme-eu', unregistered: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.capabilities.providers.delete('acme-eu', {
      idempotencyKey: 'idem-unreg',
    });
    expect(result).toEqual({ providerId: 'acme-eu', unregistered: true });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/providers/acme-eu/unregister');
    expect(req.headers['idempotency-key']).toBe('idem-unreg');
    expect(req.body).toBeUndefined();
  });

  it('delete of an unknown or already-unregistered provider answers not-found', async () => {
    const stub = errorFetch(404, { code: 'provider-not-found', message: 'no such provider' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.capabilities.providers.delete('acme-gone')).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'provider' } },
    });
  });

  it('maps 404 provider-not-found onto not-found', async () => {
    const stub = errorFetch(404, { code: 'provider-not-found', message: 'no such provider' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.capabilities.providers.get('nope')).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'provider' } },
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
    await expect(client.capabilities.providers.enable('acme-eu')).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'capabilities.providers.enable' },
    });
    await expect(client.capabilities.providers.disable('acme-eu')).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'capabilities.providers.disable' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
