// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A cursor's time is one a server wrote: Postgres's `timestamptz` text or an
 * ISO 8601 time, naming a real calendar time. `Date.parse` alone took
 * `"1"`, `"x 1"` and `"Oct 9"`, so a hand-made cursor got past the route's
 * check and failed at the binding's `::timestamptz` instead of answering
 * `400 bad-input`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { HitlBinding, RunHandlerBinding, TokenAdmin, TokenResolver } from '../src/index.js';
import { encodeCursor, isCursorTime } from '../src/routes/pagination.js';

describe('isCursorTime', () => {
  test.each([
    ['2026-10-09T12:00:00.123Z', 'toISOString()'],
    ['2026-10-09T12:00:00Z', 'ISO, whole seconds'],
    ['2026-10-09T12:00:00.123456+00:00', 'ISO, microseconds and an offset'],
    ['2026-10-09 12:00:00.123456+00', 'Postgres text'],
    ['2026-10-09 12:00:00+05:30', 'Postgres text, whole seconds, a half-hour zone'],
    ['1890-01-01 00:00:00+00:53:28', 'Postgres text, a zone offset with seconds'],
  ])('takes %s (%s)', (value) => {
    expect(isCursorTime(value)).toBe(true);
  });

  test.each([
    ['1', 'a number'],
    ['2026', 'a year'],
    ['x 1', 'text Date.parse reads as a date'],
    ['Oct 9', 'a month and day'],
    ['Fri Oct 09 2026 12:00:00 GMT+0000', "Date's toString()"],
    ['2026-10-09', 'a date without a time'],
    ['2026-10-09T12:00:00', 'ISO without a zone'],
    ['2026-10-09 12:00:00', 'Postgres text without a zone'],
    ['2026-13-01T00:00:00Z', 'month 13'],
    ['2026-02-30T00:00:00Z', 'February 30'],
    ['2026-10-09T24:00:00Z', 'hour 24'],
    ['2026-10-09T12:60:00Z', 'minute 60'],
    ['0099-01-01T00:00:00Z', 'a year before 1000'],
    [' 2026-10-09T12:00:00Z', 'a leading space'],
    ['', 'nothing'],
  ])('refuses %j (%s)', (value) => {
    expect(isCursorTime(value)).toBe(false);
  });
});

const tenantId = randomUUID() as TenantId;
const TOKEN = 'cursor-time';
// A tenant admin who reviews approvals: every list here is open to them.
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN
    ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin', scopes: ['tenant-admin'] }
    : null;

// Every list whose cursor carries a time; a refused cursor never reaches its binding.
const app = createApp({
  ...createStubAppBindings(),
  resolveToken,
  runHandler: {} as RunHandlerBinding,
  hitlBinding: {
    listApprovals: async () => ({ kind: 'ok', value: { approvals: [] } }),
  } as unknown as HitlBinding,
  reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
  tokenAdmin: { list: async () => [] } as unknown as TokenAdmin,
});

async function list(path: string, cursor: string) {
  const res = await app.request(`${path}?cursor=${encodeURIComponent(cursor)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}

describe("every route's cursor refuses a hand-made time", () => {
  const handMade = ['1', 'x 1', 'Oct 9', '2026-02-30T00:00:00Z'];

  test.each(['/v1/conversations', '/v1/runs', '/v1/approvals', '/v1/tokens'])(
    '%s: 400 bad-input',
    async (path) => {
      for (const time of handMade) {
        const answer = await list(path, encodeCursor({ createdAt: time, id: randomUUID() }));
        expect({ time, ...answer }).toEqual({ time, status: 400, code: 'bad-input' });
      }
    },
  );

  test("/v1/approvals' bare cursor from before: 400 bad-input", async () => {
    for (const time of handMade) {
      expect({ time, ...(await list('/v1/approvals', time)) }).toEqual({
        time,
        status: 400,
        code: 'bad-input',
      });
    }
  });
});
