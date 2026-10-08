// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 'test-token' };
const API = 'https://api.example.com';

const SAMPLE_SCHEDULE = {
  scheduleId: '11111111-1111-1111-1111-111111111111',
  triggerId: '11111111-1111-1111-1111-111111111111',
  flowId: 'flow.hello',
  flowVersion: '1.0.0',
  cronExpression: '*/5 * * * *',
  label: 'every-five',
  status: 'active',
  nextFireAt: '2026-09-24T00:00:00Z',
  lastFiredAt: null,
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
};

describe('schedules — wire round-trips', () => {
  it('register: POST /v1/schedules with body + optional idempotency-key', async () => {
    const stub = jsonFetch(SAMPLE_SCHEDULE, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const result = await client.schedules.register(
      {
        flowId: 'flow.hello',
        flowVersion: '1.0.0',
        config: { cronExpression: '*/5 * * * *' },
        label: 'every-five',
      },
      { idempotencyKey: 'idem-1' },
    );
    expect(result.status).toBe('active');
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/schedules`);
    expect(call.headers.authorization).toBe(`Bearer ${AUTH.token}`);
    expect(call.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(call.body ?? '{}').config.cronExpression).toBe('*/5 * * * *');
  });

  it('list: GET /v1/schedules with query params', async () => {
    const page = { data: [SAMPLE_SCHEDULE], hasMore: false };
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.schedules.list({ limit: 10, status: 'active', cursor: 'c1' });
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toMatch(/\/v1\/schedules\?/);
    expect(call.url).toMatch(/limit=10/);
    expect(call.url).toMatch(/status=active/);
    expect(call.url).toMatch(/cursor=c1/);
  });

  it('get: GET /v1/schedules/:triggerId (URI-encoded)', async () => {
    const stub = jsonFetch(SAMPLE_SCHEDULE);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.schedules.get('trig 1');
    expect(stub.calls[0]?.url).toBe(`${API}/v1/schedules/trig%201`);
  });

  it('update: PATCH /v1/schedules/:triggerId with body', async () => {
    const stub = jsonFetch(SAMPLE_SCHEDULE);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.schedules.update('t1', { label: null, config: { cronExpression: '0 * * * *' } });
    const call = stub.calls[0]!;
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body ?? '{}').label).toBeNull();
  });

  it('pause / resume / unregister: POST /v1/schedules/:triggerId/{op}', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_SCHEDULE) },
      { status: 200, body: JSON.stringify(SAMPLE_SCHEDULE) },
      {
        status: 200,
        body: JSON.stringify({ scheduleId: 't1', unregistered: true }),
      },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.schedules.pause('t1');
    await client.schedules.resume('t1');
    const un = await client.schedules.unregister('t1');
    expect(un.unregistered).toBe(true);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/schedules/t1/pause',
      'POST /v1/schedules/t1/resume',
      'POST /v1/schedules/t1/unregister',
    ]);
  });
});

describe('schedules — agents, history, run-now, ownership', () => {
  const ID = SAMPLE_SCHEDULE.triggerId;

  it('register an agent schedule with its policies', async () => {
    const stub = jsonFetch(
      { ...SAMPLE_SCHEDULE, flowId: undefined, flowVersion: undefined, agentId: 'acme.digest' },
      { status: 201 },
    );
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.schedules.register({
      agentId: 'acme.digest',
      config: { cronExpression: '0 7 * * 1-5', timezone: 'America/Toronto' },
      catchUp: 'skip',
      overlap: 'skip',
    });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toMatchObject({
      agentId: 'acme.digest',
      catchUp: 'skip',
      overlap: 'skip',
    });
  });

  it('get with upcoming; fires; run-now; take ownership', async () => {
    const fire = {
      fireId: 'f-1',
      scheduleId: ID,
      triggerId: ID,
      firedAt: '2026-10-07T07:00:01Z',
      outcome: 'pending',
      manual: true,
    };
    const stub = recordingFetch([
      {
        status: 200,
        body: JSON.stringify({ ...SAMPLE_SCHEDULE, upcoming: ['2026-10-08T07:00:00Z'] }),
      },
      { status: 200, body: JSON.stringify({ data: [fire], hasMore: false }) },
      { status: 202, body: JSON.stringify(fire) },
      { status: 200, body: JSON.stringify(SAMPLE_SCHEDULE) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect((await client.schedules.get(ID, { upcoming: 1 })).upcoming).toHaveLength(1);
    expect((await client.schedules.fires(ID, { limit: 5 })).data[0]?.manual).toBe(true);
    expect((await client.schedules.runNow(ID)).outcome).toBe('pending');
    await client.schedules.takeOwnership(ID);
    expect(
      stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`),
    ).toEqual([
      `GET /v1/schedules/${ID}?upcoming=1`,
      `GET /v1/schedules/${ID}/fires?limit=5`,
      `POST /v1/schedules/${ID}/run-now`,
      `POST /v1/schedules/${ID}/owner`,
    ]);
  });
});
