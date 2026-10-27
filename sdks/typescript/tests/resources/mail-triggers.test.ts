// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 'test-token' };
const API = 'https://api.example.com';
const TRIGGER = '22222222-2222-4222-8222-222222222222';
const RUN = '66666666-6666-4666-8666-666666666666';

const SAMPLE_TRIGGER = {
  triggerId: TRIGGER,
  agentId: 'acme.support',
  projectId: '55555555-5555-4555-8555-555555555555',
  owner: { kind: 'user', id: 'user-1' },
  mailbox: { app: 'google', as: 'person' },
  pollSeconds: 60,
  runsPerHour: 60,
  label: null,
  status: 'active',
  account: { id: 'acct-1', label: 'support@acme.example' },
  lastFiredAt: null,
  createdAt: '2026-10-26T00:00:00Z',
  updatedAt: '2026-10-26T00:00:00Z',
};

describe('mail triggers — wire round-trips', () => {
  it('register: POST /v1/mail-triggers with the mailbox and the pace', async () => {
    const stub = jsonFetch(SAMPLE_TRIGGER, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const result = await client.mailTriggers.register(
      {
        agentId: 'acme.support',
        config: { mailbox: { app: 'google', as: 'person' }, pollSeconds: 120 },
      },
      { idempotencyKey: 'idem-1' },
    );
    expect(result.mailbox).toEqual({ app: 'google', as: 'person' });
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/mail-triggers`);
    expect(call.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(call.body ?? '{}').config).toEqual({
      mailbox: { app: 'google', as: 'person' },
      pollSeconds: 120,
    });
  });

  it('list: GET /v1/mail-triggers with the project and status filters', async () => {
    const stub = jsonFetch({ data: [SAMPLE_TRIGGER], hasMore: false });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.mailTriggers.list({
      projectId: SAMPLE_TRIGGER.projectId,
      status: 'paused',
      limit: 5,
    });
    const url = stub.calls[0]?.url ?? '';
    expect(url).toMatch(/\/v1\/mail-triggers\?/);
    expect(url).toMatch(new RegExp(`projectId=${SAMPLE_TRIGGER.projectId}`));
    expect(url).toMatch(/status=paused/);
    expect(url).toMatch(/limit=5/);
  });

  it('get / update: /v1/mail-triggers/:triggerId (URI-encoded); update clears the label with null', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.mailTriggers.get('trig 1');
    await client.mailTriggers.update(TRIGGER, {
      label: null,
      config: { mailbox: { app: 'microsoft', as: 'person' } },
      toolsAllowedUnattended: [],
    });
    expect(stub.calls[0]?.url).toBe(`${API}/v1/mail-triggers/trig%201`);
    expect(stub.calls[1]?.method).toBe('PATCH');
    expect(JSON.parse(stub.calls[1]?.body ?? '{}')).toEqual({
      label: null,
      config: { mailbox: { app: 'microsoft', as: 'person' } },
      toolsAllowedUnattended: [],
    });
  });

  it('pause / resume / unregister / owner: POST /v1/mail-triggers/:triggerId/{op}', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify({ triggerId: TRIGGER, unregistered: true }) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.mailTriggers.pause(TRIGGER);
    await client.mailTriggers.resume(TRIGGER);
    expect((await client.mailTriggers.unregister(TRIGGER)).unregistered).toBe(true);
    await client.mailTriggers.takeOwnership(TRIGGER, { runAsServiceAccountId: 'sa-support' });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/v1/mail-triggers/${TRIGGER}/pause`,
      `POST ${API}/v1/mail-triggers/${TRIGGER}/resume`,
      `POST ${API}/v1/mail-triggers/${TRIGGER}/unregister`,
      `POST ${API}/v1/mail-triggers/${TRIGGER}/owner`,
    ]);
    expect(JSON.parse(stub.calls[3]?.body ?? '{}')).toEqual({
      runAsServiceAccountId: 'sa-support',
    });
  });

  it('fires: GET /v1/mail-triggers/:triggerId/fires, paged, with why a fire waits', async () => {
    const page = {
      data: [
        {
          fireId: 'f1',
          triggerId: TRIGGER,
          firedAt: '2026-10-26T10:00:00Z',
          outcome: 'pending',
          detail: `thread-busy: waits for run ${RUN}`,
        },
      ],
      hasMore: true,
      nextCursor: 'c2',
    };
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const res = await client.mailTriggers.fires(TRIGGER, { limit: 20, cursor: 'c1' });
    expect(res.data[0]?.detail).toBe(`thread-busy: waits for run ${RUN}`);
    const url = stub.calls[0]?.url ?? '';
    expect(url).toMatch(new RegExp(`/v1/mail-triggers/${TRIGGER}/fires\\?`));
    expect(url).toMatch(/limit=20/);
    expect(url).toMatch(/cursor=c1/);
  });
});
