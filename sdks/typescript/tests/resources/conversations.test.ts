// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_CONVERSATION = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  agentId: 'acme.drafter',
  agentVersion: '1.0.0',
  title: 'Contract review — Acme MSA',
  scope: {},
  status: 'open' as const,
  openedAt: '2026-09-20T00:00:00Z',
  turnCount: 0,
};

describe('conversations.open', () => {
  it('POSTs /v1/conversations with body + Idempotency-Key and returns Conversation', async () => {
    const stub = jsonFetch(WIRE_CONVERSATION, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const c = await client.conversations.open(
      {
        agentId: 'acme.drafter' as never,
        agentVersion: '1.0.0',
        title: 'Contract review — Acme MSA',
        scope: { matterId: 'm-1' },
      },
      { idempotencyKey: 'idem-o' },
    );

    expect(c.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(c.status).toBe('open');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/conversations');
    expect(req.headers['idempotency-key']).toBe('idem-o');
    expect(JSON.parse(req.body ?? '{}')).toMatchObject({
      agentId: 'acme.drafter',
      agentVersion: '1.0.0',
      title: 'Contract review — Acme MSA',
      scope: { matterId: 'm-1' },
    });
  });
});

describe('conversations.get', () => {
  it('GETs /v1/conversations/{conversationId}', async () => {
    const stub = jsonFetch(WIRE_CONVERSATION);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const c = await client.conversations.get('00000000-0000-4000-8000-000000000001' as never);
    expect(c.turnCount).toBe(0);
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/conversations/00000000-0000-4000-8000-000000000001',
    );
  });

  it('maps 404 conversation-not-found to NotFoundError', async () => {
    const stub = errorFetch(404, {
      code: 'conversation-not-found',
      message: 'no such conversation',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.conversations.get('x' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('conversations.list', () => {
  it('GETs /v1/conversations with agentId/status filters', async () => {
    const stub = jsonFetch({ data: [WIRE_CONVERSATION], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.conversations.list({
      agent: 'acme.drafter' as never,
      status: 'open',
      limit: 5,
    });

    expect(page.items[0]?.id).toBe('00000000-0000-4000-8000-000000000001');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('agentId')).toBe('acme.drafter');
    expect(url.searchParams.get('status')).toBe('open');
    expect(url.searchParams.get('limit')).toBe('5');
  });
});

describe('conversations.close', () => {
  it('POSTs /v1/conversations/{conversationId}/close and returns Conversation', async () => {
    const stub = jsonFetch({
      ...WIRE_CONVERSATION,
      status: 'closed',
      closedAt: '2026-09-21T00:00:00Z',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const c = await client.conversations.close('00000000-0000-4000-8000-000000000001' as never, {
      idempotencyKey: 'idem-c',
    });
    expect(c.status).toBe('closed');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://api.example.com/v1/conversations/00000000-0000-4000-8000-000000000001/close',
    );
    expect(req.headers['idempotency-key']).toBe('idem-c');
  });
});

describe('conversations.messages', () => {
  it('GETs /v1/conversations/{conversationId}/messages', async () => {
    const stub = jsonFetch({
      data: [
        {
          sequence: 0,
          role: 'user' as const,
          content: 'Hello',
          createdAt: '2026-09-20T00:00:01Z',
        },
      ],
      hasMore: false,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.conversations.messages(
      '00000000-0000-4000-8000-000000000001' as never,
      { limit: 10 },
    );

    expect(page.items[0]?.sequence).toBe(0);
    expect(page.items[0]?.role).toBe('user');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/conversations/00000000-0000-4000-8000-000000000001/messages');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});

describe('conversations.list — status (GET /v1/conversations takes one status)', () => {
  it('sends a single status as ?status=', async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.conversations.list({ status: 'closed' });

    expect(new URL(stub.calls[0]?.url ?? '').searchParams.getAll('status')).toEqual(['closed']);
  });

  it('rejects several statuses without sending a request the API would refuse', async () => {
    const stub = errorFetch(400, {
      code: 'bad-input',
      message: '`status` must be one of: open, closed',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const err = await client.conversations
      .list({ status: ['open', 'closed'] } as never)
      .catch((e: unknown) => e);

    // No request goes out: the API refuses a comma-joined `status`.
    expect(stub.calls.map((c) => new URL(c.url).search)).toEqual([]);
    expect(err).toMatchObject({
      name: 'KindgiApiError',
      error: { code: 'invalid-request', issues: [{ path: '/status' }] },
    });
  });
});
