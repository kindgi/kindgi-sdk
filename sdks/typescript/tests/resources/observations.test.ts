// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { KindgiApiError, createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 'tk' };

const WIRE_OBSERVATION = {
  id: 'obs-1',
  tenantId: 't-1',
  supervisorId: 'sup-1',
  agentId: 'ag-1',
  agentVersion: '1.0.0',
  conversationId: 'conv-1',
  turnNumber: 3,
  status: 'guardrail-violation',
  violations: [{ guardrail: 'must-cite' }],
  durationMs: 240,
  costUsd: '0.0123',
  observedAt: '2026-09-19T00:00:00.000Z',
};

describe('observations.query', () => {
  it('issues GET /v1/observations with paged wire response and returns Page shape', async () => {
    const stub = jsonFetch({ data: [WIRE_OBSERVATION], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.observations.query();

    expect(page.items.length).toBe(1);
    expect(page.items[0]?.status).toBe('guardrail-violation');
    expect(page.nextCursor).toBeUndefined();
    const req = stub.calls[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.example.com/v1/observations');
  });

  it('serializes filter fields into query params', async () => {
    const stub = jsonFetch({ data: [], hasMore: true, nextCursor: 'cur-2' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.observations.query({
      limit: 50,
      status: 'guardrail-violation',
      supervisorId: 'sup-9' as never,
      agentId: 'ag-1' as never,
    });

    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('status')).toBe('guardrail-violation');
    expect(url.searchParams.get('supervisorId')).toBe('sup-9');
    expect(url.searchParams.get('agentId')).toBe('ag-1');
    expect(page.nextCursor).toBe('cur-2');
  });

  it('recordRun throws not-yet-wired without hitting fetch', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.observations.recordRun('run-1' as never)).rejects.toMatchObject({
      name: 'KindgiApiError',
      error: { code: 'not-yet-wired', method: 'observations.recordRun' },
    });
    expect(stub.calls.length).toBe(0);
  });

  it('patterns throws not-yet-wired without hitting fetch', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    try {
      await client.observations.patterns({ supervisorId: 'sup-1' as never });
    } catch (e) {
      expect(e).toBeInstanceOf(KindgiApiError);
      expect((e as KindgiApiError).error).toMatchObject({
        code: 'not-yet-wired',
        method: 'observations.patterns',
      });
    }
    expect(stub.calls.length).toBe(0);
  });
});
