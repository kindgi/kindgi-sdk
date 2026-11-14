// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 'test-token' };
const API = 'https://api.example.com';
const TRIGGER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const RUN = '66666666-6666-4666-8666-666666666666';

const SAMPLE_TRIGGER = {
  triggerId: TRIGGER,
  agentId: 'acme.support',
  projectId: '55555555-5555-4555-8555-555555555555',
  owner: { kind: 'user', id: 'user-1' },
  connectionId: CONNECTION,
  runsPerHour: 60,
  perSenderPerHour: 10,
  label: null,
  status: 'active',
  lastFiredAt: null,
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
};

describe('text triggers - wire round-trips', () => {
  it('register: POST /v1/text-triggers with the connection and the limits', async () => {
    const stub = jsonFetch(SAMPLE_TRIGGER, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const result = await client.textTriggers.register(
      {
        agentId: 'acme.support',
        config: { connectionId: CONNECTION, perSenderPerHour: 5 },
      },
      { idempotencyKey: 'idem-1' },
    );
    expect(result.connectionId).toBe(CONNECTION);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API}/v1/text-triggers`);
    expect(call.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(call.body ?? '{}').config).toEqual({
      connectionId: CONNECTION,
      perSenderPerHour: 5,
    });
  });

  it('list: GET /v1/text-triggers with the project and status filters', async () => {
    const stub = jsonFetch({ data: [SAMPLE_TRIGGER], hasMore: false });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.textTriggers.list({
      projectId: SAMPLE_TRIGGER.projectId,
      status: 'paused',
      limit: 5,
    });
    const url = stub.calls[0]?.url ?? '';
    expect(url).toMatch(/\/v1\/text-triggers\?/);
    expect(url).toMatch(new RegExp(`projectId=${SAMPLE_TRIGGER.projectId}`));
    expect(url).toMatch(/status=paused/);
    expect(url).toMatch(/limit=5/);
  });

  it('get / update: /v1/text-triggers/:triggerId (URI-encoded); update clears the label with null', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.textTriggers.get('trig 1');
    await client.textTriggers.update(TRIGGER, {
      label: null,
      config: { runsPerHour: 30 },
      toolsAllowedUnattended: [],
    });
    expect(stub.calls[0]?.url).toBe(`${API}/v1/text-triggers/trig%201`);
    expect(stub.calls[1]?.method).toBe('PATCH');
    expect(JSON.parse(stub.calls[1]?.body ?? '{}')).toEqual({
      label: null,
      config: { runsPerHour: 30 },
      toolsAllowedUnattended: [],
    });
  });

  it('pause / resume / unregister / owner: POST /v1/text-triggers/:triggerId/{op}', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
      { status: 200, body: JSON.stringify({ triggerId: TRIGGER, unregistered: true }) },
      { status: 200, body: JSON.stringify(SAMPLE_TRIGGER) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.textTriggers.pause(TRIGGER);
    await client.textTriggers.resume(TRIGGER);
    expect((await client.textTriggers.unregister(TRIGGER)).unregistered).toBe(true);
    await client.textTriggers.takeOwnership(TRIGGER, { runAsProject: true });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/v1/text-triggers/${TRIGGER}/pause`,
      `POST ${API}/v1/text-triggers/${TRIGGER}/resume`,
      `POST ${API}/v1/text-triggers/${TRIGGER}/unregister`,
      `POST ${API}/v1/text-triggers/${TRIGGER}/owner`,
    ]);
    expect(JSON.parse(stub.calls[3]?.body ?? '{}')).toEqual({ runAsProject: true });
  });

  it('fires: GET /v1/text-triggers/:triggerId/fires, paged, with why a text was refused', async () => {
    const page = {
      data: [
        {
          fireId: 'f1',
          triggerId: TRIGGER,
          firedAt: '2026-11-04T10:00:00Z',
          outcome: 'refused',
          detail: 'over-limit: perSenderPerHour 10',
          countsTowardPause: false,
        },
        {
          fireId: 'f0',
          triggerId: TRIGGER,
          firedAt: '2026-11-04T09:00:00Z',
          outcome: 'started',
          runId: RUN,
          version: 1,
        },
      ],
      hasMore: true,
      nextCursor: 'c2',
    };
    const stub = jsonFetch(page);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const res = await client.textTriggers.fires(TRIGGER, { limit: 20, cursor: 'c1' });
    expect(res.data[0]?.detail).toBe('over-limit: perSenderPerHour 10');
    expect(res.data[1]?.runId).toBe(RUN);
    const url = stub.calls[0]?.url ?? '';
    expect(url).toMatch(new RegExp(`/v1/text-triggers/${TRIGGER}/fires\\?`));
    expect(url).toMatch(/limit=20/);
    expect(url).toMatch(/cursor=c1/);
  });

  it('versions / getVersion: GET /v1/text-triggers/:triggerId/versions, paged, and one by number', async () => {
    const v2 = {
      triggerId: TRIGGER,
      version: 2,
      createdAt: '2026-11-04T10:00:00Z',
      createdBy: 'user:u-1',
      cause: 'edit',
      definition: {
        agentId: 'acme.support',
        projectId: '33333333-3333-4333-8333-333333333333',
        owner: { kind: 'user', id: 'u-1' },
        connectionId: CONNECTION,
        runsPerHour: 30,
        perSenderPerHour: 10,
        label: null,
      },
    };
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [v2], hasMore: true, nextCursor: 'c2' }) },
      { status: 200, body: JSON.stringify(v2) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const page = await client.textTriggers.versions(TRIGGER, { limit: 1, cursor: 'c1' });
    expect(page.data[0]?.definition.connectionId).toBe(CONNECTION);
    expect(page.nextCursor).toBe('c2');
    expect((await client.textTriggers.getVersion(TRIGGER, 2)).version).toBe(2);
    expect(
      stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`),
    ).toEqual([
      `GET /v1/text-triggers/${TRIGGER}/versions?limit=1&cursor=c1`,
      `GET /v1/text-triggers/${TRIGGER}/versions/2`,
    ]);
  });

  it('a connection another trigger answers: a conflict naming that trigger', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const stub = errorFetch(409, {
      code: 'trigger-connection-taken',
      message: `Text trigger "${other}" already answers connection "${CONNECTION}"`,
      details: { heldBy: other, connectionId: CONNECTION },
    });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(
      client.textTriggers.register({
        agentId: 'acme.support',
        config: { connectionId: CONNECTION },
      }),
    ).rejects.toMatchObject({
      name: 'KindgiApiError',
      error: {
        code: 'conflict',
        reason: 'trigger-connection-taken',
        fields: { heldBy: other, connectionId: CONNECTION },
      },
    });
  });
});
