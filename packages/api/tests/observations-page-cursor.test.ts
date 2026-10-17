// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/observations`' next cursor continues after the page's last
 * observation, at its `observedAt` as stored and its id (the binding's
 * `next`), so observations at the same instant on either side of a page
 * boundary are each listed once. A binding without `next` gives its bare
 * time, as before, and a bare-time cursor a client holds still answers.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, SupervisorObservationPage, TokenResolver } from '../src/index.js';
import { decodeCursor, encodeCursor } from '../src/routes/pagination.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'observations-page-cursor';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const observation = {
  id: randomUUID(),
  tenantId,
  supervisorId: 'acme.supervisor',
  agentId: 'acme.desk',
  agentVersion: '1.0.0',
  conversationId: randomUUID(),
  turnNumber: 1,
  status: 'pass',
  violations: [],
  durationMs: 1,
  costUsd: 0,
  observedAt: '2026-10-09T12:00:00.123Z',
};

function harness(page: Omit<SupervisorObservationPage, 'data'>) {
  const seen: Record<string, unknown>[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    enableObservations: true,
    supervisor: {
      queryObservations: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { kind: 'ok', page: { data: [observation], ...page } };
      },
    } as never,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  return async (query = '') => {
    const res = await app.request(`/v1/observations?limit=1${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any>, seen };
  };
}

describe("GET /v1/observations' next cursor", () => {
  test("the binding's exact position (time as stored, and id) when it gives one", async () => {
    const next = { observedAt: '2026-10-09 12:00:00.123+00', id: observation.id };
    const { status, body } = await harness({
      next,
      nextCursor: '2026-10-09T12:00:00.123Z' as never,
    })();
    expect(status).toBe(200);
    expect(body.hasMore).toBe(true);
    expect(decodeCursor(body.nextCursor)).toEqual({ createdAt: next.observedAt, id: next.id });
  });

  test('the bare time from a binding without `next`, as before', async () => {
    const { body } = await harness({ nextCursor: '2026-10-09T12:00:00.123Z' as never })();
    expect(body.nextCursor).toBe('2026-10-09T12:00:00.123Z');
    expect(body.hasMore).toBe(true);
  });

  test('none on the last page', async () => {
    const { body } = await harness({})();
    expect(body.hasMore).toBe(false);
    expect(body).not.toHaveProperty('nextCursor');
  });

  test('a position cursor reaches the binding as `after`', async () => {
    const cursor = encodeCursor({ createdAt: '2026-10-09 12:00:00.123+00', id: observation.id });
    const { status, seen } = await harness({})(`&cursor=${cursor}`);
    expect(status).toBe(200);
    expect(seen[0]?.after).toEqual({
      observedAt: '2026-10-09 12:00:00.123+00',
      id: observation.id,
    });
    expect(seen[0]).not.toHaveProperty('cursor');
  });

  test('a bare-time cursor from before reaches the binding as `cursor`', async () => {
    const { status, seen } = await harness({})('&cursor=2026-10-09T12:00:00.123Z');
    expect(status).toBe(200);
    expect(seen[0]?.cursor).toBe('2026-10-09T12:00:00.123Z');
    expect(seen[0]).not.toHaveProperty('after');
  });

  test.each([
    ['not a cursor', 'not-a-cursor'],
    [
      'a position whose time is not a time',
      encodeCursor({ createdAt: 'nope', id: observation.id }),
    ],
    [
      'a position whose id is not an id',
      encodeCursor({ createdAt: '2026-10-09T12:00:00Z', id: 'x' }),
    ],
  ])('%s: 400 bad-input, the binding not called', async (_name, cursor) => {
    const { status, body, seen } = await harness({})(`&cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad-input');
    expect(seen).toEqual([]);
  });
});
