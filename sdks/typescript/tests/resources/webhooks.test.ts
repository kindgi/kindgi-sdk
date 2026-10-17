// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 'test-token' };
const API = 'https://api.example.com';
const TRIGGER = '22222222-2222-4222-8222-222222222222';

const SAMPLE_TRIGGER = {
  triggerId: TRIGGER,
  webhookId: '33333333-3333-4333-8333-333333333333',
  receiveUrl:
    'https://kindgi.acme.example/v1/hooks/44444444-4444-4444-8444-444444444444/33333333-3333-4333-8333-333333333333',
  flowId: 'acme.refund-review',
  flowVersion: '1.0.0',
  projectId: '55555555-5555-4555-8555-555555555555',
  owner: { kind: 'user', id: 'user-1' },
  hmacSecretName: 'acme-woo-secret',
  signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
  deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
  bodyLimitBytes: 262144,
  rateLimitPerMinute: 600,
  label: null,
  status: 'active',
  lastFiredAt: null,
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
};

describe('webhooks (inbound triggers) — wire round-trips', () => {
  it('register: POST /v1/webhooks with the scheme and the delivery-id header', async () => {
    const stub = jsonFetch(SAMPLE_TRIGGER, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const result = await client.webhooks.register(
      {
        flowId: 'acme.refund-review',
        flowVersion: '1.0.0',
        hmacSecretName: 'acme-woo-secret',
        signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
        deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
      },
      { idempotencyKey: 'idem-1' },
    );
    expect(result.receiveUrl).toBe(SAMPLE_TRIGGER.receiveUrl);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/webhooks`);
    expect(call.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(call.body ?? '{}').signature.encoding).toBe('base64');
  });

  it('list: GET /v1/webhooks with the project filter', async () => {
    const stub = jsonFetch({ data: [SAMPLE_TRIGGER], hasMore: false });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.webhooks.list({ projectId: SAMPLE_TRIGGER.projectId, status: 'paused', limit: 5 });
    const url = stub.calls[0]?.url ?? '';
    expect(url).toMatch(/\/v1\/webhooks\?/);
    expect(url).toMatch(new RegExp(`projectId=${SAMPLE_TRIGGER.projectId}`));
    expect(url).toMatch(/status=paused/);
    expect(url).toMatch(/limit=5/);
  });

  it('get / update: /v1/webhooks/:triggerId (URI-encoded); update clears with null', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.webhooks.get('trig 1');
    await client.webhooks.update(TRIGGER, { deliveryIdHeader: null, flowVersion: '1.1.0' });
    expect(stub.calls[0]?.url).toBe(`${API}/v1/webhooks/trig%201`);
    expect(stub.calls[1]?.method).toBe('PATCH');
    expect(JSON.parse(stub.calls[1]?.body ?? '{}')).toEqual({
      deliveryIdHeader: null,
      flowVersion: '1.1.0',
    });
  });

  it('pause / resume / unregister / owner: POST /v1/webhooks/:triggerId/{op}', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify({ triggerId: TRIGGER, unregistered: true }) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.webhooks.pause(TRIGGER);
    await client.webhooks.resume(TRIGGER);
    expect((await client.webhooks.unregister(TRIGGER)).unregistered).toBe(true);
    await client.webhooks.takeOwnership(TRIGGER);
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/v1/webhooks/${TRIGGER}/pause`,
      `POST ${API}/v1/webhooks/${TRIGGER}/resume`,
      `POST ${API}/v1/webhooks/${TRIGGER}/unregister`,
      `POST ${API}/v1/webhooks/${TRIGGER}/owner`,
    ]);
  });

  it('fires: GET /v1/webhooks/:triggerId/fires, paged', async () => {
    const page = {
      data: [
        {
          fireId: 'f1',
          triggerId: TRIGGER,
          firedAt: '2026-10-10T10:00:00Z',
          outcome: 'refused',
          detail: 'signature-invalid',
        },
      ],
      hasMore: true,
      nextCursor: 'c2',
    };
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const res = await client.webhooks.fires(TRIGGER, { limit: 20, cursor: 'c1' });
    expect(res.data[0]?.detail).toBe('signature-invalid');
    const url = stub.calls[0]?.url ?? '';
    expect(url).toMatch(new RegExp(`/v1/webhooks/${TRIGGER}/fires\\?`));
    expect(url).toMatch(/limit=20/);
    expect(url).toMatch(/cursor=c1/);
  });
});
