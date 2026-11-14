// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, noContentFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const PROJECT = '00000000-0000-4000-8000-000000000001';

const DESTINATION = {
  destinationId: 'dst-1',
  name: 'Acme ops channel',
  kind: 'slack',
  host: 'hooks.slack.com',
  urlRef: { envName: 'local', name: 'kindgi.destination.dst-1' },
  content: 'link',
  status: 'active',
  lastError: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const DELIVERY = {
  deliveryId: 'dd-1',
  to: 'dst-1',
  event: 'destination.test',
  scheduleId: null,
  runId: null,
  approvalId: null,
  status: 'pending',
  reason: null,
  attempts: 0,
  nextAttemptAt: '2026-10-01T00:00:00Z',
  lastAttemptAt: null,
  lastResponseStatus: null,
  lastError: null,
  createdAt: '2026-10-01T00:00:00Z',
  deliveredAt: null,
};

describe('destinations: wire round-trips', () => {
  it('create: POST /v1/destinations with a write-only url', async () => {
    const stub = jsonFetch(DESTINATION, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const created = await client.destinations.create(
      {
        name: 'Acme ops channel',
        kind: 'slack',
        url: 'https://hooks.slack.com/services/T000/B000/x',
        projects: [PROJECT],
      },
      { idempotencyKey: 'k-1' },
    );
    expect(created.host).toBe('hooks.slack.com');
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/destinations`);
    expect(call.headers['idempotency-key']).toBe('k-1');
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      name: 'Acme ops channel',
      kind: 'slack',
      url: 'https://hooks.slack.com/services/T000/B000/x',
      projects: [PROJECT],
    });
  });

  it('list (one project), get, update: methods and paths', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [DESTINATION], hasMore: false }) },
      { status: 200, body: JSON.stringify(DESTINATION) },
      { status: 200, body: JSON.stringify(DESTINATION) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const page = await client.destinations.list({ projectId: PROJECT, limit: 10 });
    expect(page.data[0]?.destinationId).toBe('dst-1');
    await client.destinations.get('dst/1');
    await client.destinations.update('dst-1', { projects: null });

    expect(stub.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      `GET /v1/destinations?limit=10&projectId=${PROJECT}`,
      'GET /v1/destinations/dst%2F1',
      'PATCH /v1/destinations/dst-1',
    ]);
    expect(JSON.parse(stub.calls[2]!.body ?? '{}')).toEqual({ projects: null });
  });

  it('remove: DELETE /v1/destinations/:destinationId, 204 with no body', async () => {
    const stub = noContentFetch();
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(client.destinations.remove('dst-1')).resolves.toBeUndefined();
    expect(`${stub.calls[0]?.method} ${stub.calls[0]?.url}`).toBe(
      `DELETE ${API}/v1/destinations/dst-1`,
    );
  });

  it('deliveries: list with a status filter, redeliver, send a test message', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [DELIVERY], hasMore: false }) },
      { status: 202, body: JSON.stringify(DELIVERY) },
      { status: 202, body: JSON.stringify(DELIVERY) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const page = await client.destinations.listDeliveries('dst-1', { status: 'skipped' });
    expect(page.data[0]?.event).toBe('destination.test');
    await client.destinations.redeliver('dst-1', 'dd-1');
    const queued = await client.destinations.sendTest('dst-1');
    expect(queued.status).toBe('pending');

    expect(stub.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'GET /v1/destinations/dst-1/deliveries?status=skipped',
      'POST /v1/destinations/dst-1/deliveries/dd-1/redeliver',
      'POST /v1/destinations/dst-1/test',
    ]);
  });
});
