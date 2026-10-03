// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_EVENT_TRIGGER = {
  eventTriggerId: '33333333-3333-3333-3333-333333333333',
  triggerId: '33333333-3333-3333-3333-333333333333',
  flowId: 'flow.on-approval',
  flowVersion: '1.0.0',
  eventKind: 'approval.expired',
  label: 'auto-withdraw',
  status: 'active',
  lastFiredAt: null,
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
};

describe('event-triggers — wire round-trips', () => {
  it('register: POST /v1/event-triggers', async () => {
    const stub = jsonFetch(SAMPLE_EVENT_TRIGGER, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const result = await client.eventTriggers.register({
      flowId: 'flow.on-approval',
      flowVersion: '1.0.0',
      config: { eventKind: 'approval.expired' },
    });
    expect(result.eventKind).toBe('approval.expired');
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/event-triggers`);
  });

  it('lifecycle: list + get + update + pause + resume + unregister', async () => {
    const page = { data: [SAMPLE_EVENT_TRIGGER], hasMore: false };
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(page) },
      { status: 200, body: JSON.stringify(SAMPLE_EVENT_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_EVENT_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_EVENT_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_EVENT_TRIGGER) },
      {
        status: 200,
        body: JSON.stringify({ eventTriggerId: 't1', unregistered: true }),
      },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.eventTriggers.list({ status: 'active' });
    await client.eventTriggers.get('t1');
    await client.eventTriggers.update('t1', { label: 'renamed' });
    await client.eventTriggers.pause('t1');
    await client.eventTriggers.resume('t1');
    const un = await client.eventTriggers.unregister('t1');
    expect(un.unregistered).toBe(true);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/event-triggers',
      'GET /v1/event-triggers/t1',
      'PATCH /v1/event-triggers/t1',
      'POST /v1/event-triggers/t1/pause',
      'POST /v1/event-triggers/t1/resume',
      'POST /v1/event-triggers/t1/unregister',
    ]);
  });
});
