// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const ENDPOINT = {
  endpointId: 'ep-1',
  url: 'https://app.example.com/hooks/kindgi',
  events: ['run.finished'],
  filter: { flowIds: ['acme.order-review'] },
  description: null,
  secretRef: { envName: 'local', name: 'ACME_WEBHOOK_SECRET' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const DELIVERY = {
  deliveryId: 'dl-1',
  endpointId: 'ep-1',
  event: {
    id: 'evt-1',
    type: 'webhook.test',
    createdAt: '2026-10-01T00:00:00Z',
    data: { endpointId: 'ep-1' },
  },
  status: 'pending',
  attempts: 0,
  nextAttemptAt: '2026-10-01T00:00:00Z',
  lastAttemptAt: null,
  lastResponseStatus: null,
  lastError: null,
  createdAt: '2026-10-01T00:00:00Z',
  deliveredAt: null,
};

describe('webhookEndpoints — wire round-trips', () => {
  it('create: POST /v1/webhook-endpoints with a secret reference', async () => {
    const stub = jsonFetch(ENDPOINT, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const created = await client.webhookEndpoints.create(
      {
        url: ENDPOINT.url,
        events: ['run.finished'],
        filter: { flowIds: ['acme.order-review'] },
        secretRef: { envName: 'local', name: 'ACME_WEBHOOK_SECRET' },
      },
      { idempotencyKey: 'k-1' },
    );
    expect(created.endpointId).toBe('ep-1');
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/webhook-endpoints`);
    expect(call.headers['idempotency-key']).toBe('k-1');
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      url: ENDPOINT.url,
      events: ['run.finished'],
      filter: { flowIds: ['acme.order-review'] },
      secretRef: { envName: 'local', name: 'ACME_WEBHOOK_SECRET' },
    });
  });

  it('generateSecret: POST /v1/webhook-endpoints/generate-secret', async () => {
    const stub = jsonFetch({ secret: 'whsec_c2VjcmV0' });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const generated = await client.webhookEndpoints.generateSecret();
    expect(generated.secret).toBe('whsec_c2VjcmV0');
    expect(`${stub.calls[0]?.method} ${stub.calls[0]?.url}`).toBe(
      `POST ${API}/v1/webhook-endpoints/generate-secret`,
    );
  });

  it('list, get, update, unregister: methods and paths', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [ENDPOINT], hasMore: false }) },
      { status: 200, body: JSON.stringify(ENDPOINT) },
      { status: 200, body: JSON.stringify(ENDPOINT) },
      { status: 200, body: JSON.stringify({ endpointId: 'ep-1', unregistered: true }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.webhookEndpoints.list({ limit: 10 });
    await client.webhookEndpoints.get('ep/1');
    await client.webhookEndpoints.update('ep-1', { description: null });
    await client.webhookEndpoints.unregister('ep-1');

    expect(stub.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'GET /v1/webhook-endpoints?limit=10',
      'GET /v1/webhook-endpoints/ep%2F1',
      'PATCH /v1/webhook-endpoints/ep-1',
      'POST /v1/webhook-endpoints/ep-1/unregister',
    ]);
    expect(JSON.parse(stub.calls[2]!.body ?? '{}')).toEqual({ description: null });
  });

  it('deliveries: list with a status filter, redeliver, send a test event', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [DELIVERY], hasMore: false }) },
      { status: 202, body: JSON.stringify(DELIVERY) },
      { status: 202, body: JSON.stringify(DELIVERY) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const page = await client.webhookEndpoints.listDeliveries('ep-1', { status: 'failed' });
    expect(page.data[0]?.event.type).toBe('webhook.test');
    await client.webhookEndpoints.redeliver('ep-1', 'dl-1');
    const queued = await client.webhookEndpoints.sendTest('ep-1');
    expect(queued.status).toBe('pending');

    expect(stub.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'GET /v1/webhook-endpoints/ep-1/deliveries?status=failed',
      'POST /v1/webhook-endpoints/ep-1/deliveries/dl-1/redeliver',
      'POST /v1/webhook-endpoints/ep-1/test',
    ]);
  });
});
