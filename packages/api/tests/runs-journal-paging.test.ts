// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs/:runId/journal` pages only when asked: with `limit`, at most
 * that many entries and a `nextCursor` while more remain; without it, the
 * whole journal in one answer, as before paging.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { JournalEntry, RunBinding } from '@kindgi/runtime';
import type { RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createAeadCursorSealer, createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-journal-paging-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

function entry(sequence: number): JournalEntry {
  return {
    sequence,
    kind: 'step.completed',
    timestamp: new Date(Date.UTC(2026, 9, 14, 12, 0, sequence)).toISOString() as Timestamp,
  } as unknown as JournalEntry;
}

/** A run whose journal has entries 1..`count`; `sealed` adds the runtime's cursor sealer. */
function appWithJournal(count: number, sealed = false) {
  const runId = randomUUID() as RunId;
  const journal = Array.from({ length: count }, (_, i) => entry(i + 1));
  const reads: RunId[] = [];
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    readJournal: async (_tenantId: TenantId, id: RunId) => {
      reads.push(id);
      return { kind: 'ok' as const, value: journal };
    },
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...(sealed && {
      cursorSealer: createAeadCursorSealer({
        keys: [{ kid: 'k', key: new Uint8Array(32).fill(9) }],
      }),
    }),
  });
  const get = async (query: string) => {
    const res = await app.request(`/v1/runs/${runId}/journal${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        data?: { sequence: number }[];
        hasMore?: boolean;
        nextCursor?: string;
        error?: { code: string };
      },
    };
  };
  return { get, reads };
}

const sequences = (data: readonly { sequence: number }[] | undefined) =>
  (data ?? []).map((e) => e.sequence);

describe('GET /v1/runs/:runId/journal paging', () => {
  test('without limit: the whole journal in one answer, and no cursor', async () => {
    const { get } = appWithJournal(130);
    // An empty `limit` is no limit, as an empty `cursor` is no cursor.
    for (const query of ['', '?limit=&cursor=']) {
      const { status, body } = await get(query);
      expect(status).toBe(200);
      expect(sequences(body.data)).toHaveLength(130);
      expect(body.hasMore).toBe(false);
      expect(body).not.toHaveProperty('nextCursor');
    }
  });

  test('with limit: walking nextCursor gives every entry once, in order', async () => {
    const { get } = appWithJournal(7);
    const seen: number[] = [];
    let query = '?limit=3';
    const pages: { hasMore: boolean | undefined; size: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const { status, body } = await get(query);
      expect(status).toBe(200);
      seen.push(...sequences(body.data));
      pages.push({ hasMore: body.hasMore, size: sequences(body.data).length });
      if (body.hasMore !== true) {
        expect(body).not.toHaveProperty('nextCursor');
        break;
      }
      expect(typeof body.nextCursor).toBe('string');
      query = `?limit=3&cursor=${encodeURIComponent(body.nextCursor ?? '')}`;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pages).toEqual([
      { hasMore: true, size: 3 },
      { hasMore: true, size: 3 },
      { hasMore: false, size: 1 },
    ]);
  });

  test('a page that ends exactly at the end says no more', async () => {
    const { get } = appWithJournal(6);
    const first = await get('?limit=3');
    expect(first.body.hasMore).toBe(true);
    const second = await get(`?limit=3&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`);
    expect(sequences(second.body.data)).toEqual([4, 5, 6]);
    expect(second.body.hasMore).toBe(false);
    expect(second.body).not.toHaveProperty('nextCursor');
  });

  test('a cursor without limit gives the rest of the journal', async () => {
    const { get } = appWithJournal(5);
    const first = await get('?limit=2');
    const rest = await get(`?cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`);
    expect(sequences(rest.body.data)).toEqual([3, 4, 5]);
    expect(rest.body.hasMore).toBe(false);
  });

  test('since and limit together: pages of the entries after since', async () => {
    const { get } = appWithJournal(10);
    const first = await get('?since=4&limit=4');
    expect(sequences(first.body.data)).toEqual([5, 6, 7, 8]);
    expect(first.body.hasMore).toBe(true);
    const second = await get(
      `?since=4&limit=4&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    );
    expect(sequences(second.body.data)).toEqual([9, 10]);
    expect(second.body.hasMore).toBe(false);
  });

  test('with the cursor sealer: the sealed cursors walk the journal, since kept', async () => {
    const { get } = appWithJournal(9, true);
    const first = await get('?since=2&limit=3');
    expect(sequences(first.body.data)).toEqual([3, 4, 5]);
    // Sealed: nothing in it reads as the position.
    expect(first.body.nextCursor).not.toBe(
      Buffer.from(JSON.stringify({ sequence: 5 })).toString('base64url'),
    );
    const cursor = encodeURIComponent(first.body.nextCursor ?? '');
    const second = await get(`?since=2&limit=3&cursor=${cursor}`);
    expect(second.status).toBe(200);
    expect(sequences(second.body.data)).toEqual([6, 7, 8]);
    // Sealed for `since=2`: another `since` refuses it.
    const other = await get(`?since=0&limit=3&cursor=${cursor}`);
    expect(other.status).toBe(400);
    expect(other.body.error?.code).toBe('bad-input');
  });

  test('a limit that is not a whole number from 1 is 400 bad-input, and the journal is not read', async () => {
    const { get, reads } = appWithJournal(3);
    for (const limit of ['0', '-1', 'abc', '2.5', '1e2']) {
      const { status, body } = await get(`?limit=${limit}`);
      expect(status).toBe(400);
      expect(body.error?.code).toBe('bad-input');
    }
    expect(reads).toEqual([]);
  });

  test('limit is at most 100', async () => {
    const { get } = appWithJournal(130);
    const { body } = await get('?limit=500');
    expect(sequences(body.data)).toHaveLength(100);
    expect(body.hasMore).toBe(true);
  });

  test('a malformed cursor is 400 bad-input, and the journal is not read', async () => {
    const { get, reads } = appWithJournal(3);
    for (const cursor of ['not-a-cursor', Buffer.from('{"sequence":-1}').toString('base64url')]) {
      const { status, body } = await get(`?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(status).toBe(400);
      expect(body.error?.code).toBe('bad-input');
    }
    expect(reads).toEqual([]);
  });
});
