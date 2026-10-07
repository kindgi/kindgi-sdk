// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const ERASURE = {
  id: '00000000-0000-4000-8000-000000000001',
  selectorKind: 'participant',
  status: 'pending',
  phase: 'seed',
  requestedBy: 'user:admin-1',
  matchable: false,
  counts: {},
  attempts: 0,
  createdAt: '2026-10-07T00:00:00.000Z',
  warnings: [{ code: 'erasure-unmatchable', message: 'no key' }],
};
const ENTRY = {
  id: ERASURE.id,
  selectorKind: 'participant',
  requestedBy: 'user:admin-1',
  status: 'completed',
  createdAt: '2026-10-07T00:00:00.000Z',
};

function client(body: unknown, status = 200) {
  const stub = jsonFetch(body, { status });
  return {
    stub,
    kindgi: createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch }),
  };
}

describe('memory.erasures', () => {
  it('create POSTs the selector and returns the erasure with its warnings', async () => {
    const { stub, kindgi } = client(ERASURE, 202);
    const created = await kindgi.memory.erasures.create(
      { subject: { kind: 'participant', id: 'end-7' } },
      { idempotencyKey: 'erase-1' },
    );
    expect(created.warnings?.[0]?.code).toBe('erasure-unmatchable');
    const req = stub.calls[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('https://api.example.com/v1/memory/erasures');
    expect(req?.headers['idempotency-key']).toBe('erase-1');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      subject: { kind: 'participant', id: 'end-7' },
    });
  });

  it('get and list', async () => {
    const one = client(ERASURE);
    await one.kindgi.memory.erasures.get(ERASURE.id);
    expect(one.stub.calls[0]?.url).toBe(`https://api.example.com/v1/memory/erasures/${ERASURE.id}`);
    const page = client({ data: [ERASURE], hasMore: true, nextCursor: 'c-2' });
    const listed = await page.kindgi.memory.erasures.list({ limit: 5, cursor: 'c-1' });
    expect(listed.hasMore).toBe(true);
    expect(String(listed.nextCursor)).toBe('c-2');
    expect(page.stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/memory/erasures?limit=5&cursor=c-1',
    );
  });

  it('export returns the ledger; replay POSTs it back', async () => {
    const exported = client({ data: [ENTRY] });
    expect(await exported.kindgi.memory.erasures.export()).toEqual([ENTRY]);
    expect(exported.stub.calls[0]?.url).toBe('https://api.example.com/v1/memory/erasures/export');
    const replay = client({ replayed: [ENTRY.id], restored: [], unmatched: [] });
    const result = await replay.kindgi.memory.erasures.replay([ENTRY as never]);
    expect(result.replayed).toEqual([ENTRY.id]);
    expect(JSON.parse(replay.stub.calls[0]?.body ?? '{}')).toEqual({ erasures: [ENTRY] });
  });
});
