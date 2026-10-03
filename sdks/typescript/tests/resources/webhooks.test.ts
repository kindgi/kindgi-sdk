// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_WEBHOOK = {
  triggerId: '22222222-2222-2222-2222-222222222222',
  webhookId: 'aaaa-webhook-id',
  flowId: 'flow.hook',
  flowVersion: '1.0.0',
  hmacSecretName: 'webhook-trigger-aaaa-hmac',
  label: 'gh-push',
  status: 'active',
  lastFiredAt: null,
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
};

describe('webhooks — wire round-trips', () => {
  it('register: POST /v1/webhooks — plaintext HMAC never crosses (name only)', async () => {
    const stub = jsonFetch(SAMPLE_WEBHOOK, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const result = await client.webhooks.register({
      flowId: 'flow.hook',
      flowVersion: '1.0.0',
      hmacSecretName: 'webhook-trigger-aaaa-hmac',
    });
    expect(result.webhookId).toBe('aaaa-webhook-id');
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/webhooks`);
    const body = JSON.parse(call.body ?? '{}');
    expect(body.hmacSecretName).toBe('webhook-trigger-aaaa-hmac');
    // Plaintext MUST NEVER leave the SDK — the caller writes it to /v1/secrets
    // out-of-band; the register call carries only the reference name.
    expect(body.hmacSecret).toBeUndefined();
  });

  it('list + get + update + pause + resume + unregister — all HTTP', async () => {
    const page = { data: [SAMPLE_WEBHOOK], hasMore: false };
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(page) },
      { status: 200, body: JSON.stringify(SAMPLE_WEBHOOK) },
      { status: 200, body: JSON.stringify(SAMPLE_WEBHOOK) },
      { status: 200, body: JSON.stringify(SAMPLE_WEBHOOK) },
      { status: 200, body: JSON.stringify(SAMPLE_WEBHOOK) },
      {
        status: 200,
        body: JSON.stringify({ triggerId: 't1', unregistered: true }),
      },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.webhooks.list({ status: 'active' });
    await client.webhooks.get('t1');
    await client.webhooks.update('t1', { label: 'renamed' });
    await client.webhooks.pause('t1');
    await client.webhooks.resume('t1');
    const un = await client.webhooks.unregister('t1');
    expect(un.unregistered).toBe(true);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/webhooks',
      'GET /v1/webhooks/t1',
      'PATCH /v1/webhooks/t1',
      'POST /v1/webhooks/t1/pause',
      'POST /v1/webhooks/t1/resume',
      'POST /v1/webhooks/t1/unregister',
    ]);
  });
});
