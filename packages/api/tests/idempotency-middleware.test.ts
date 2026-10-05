// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import {
  createInMemoryIdempotencyStore,
  idempotencyMiddleware,
} from '../src/middleware/idempotency.js';
import type { AppEnv } from '../src/types.js';

/**
 * A route behind the middleware whose answer the test sets per call, and
 * a count of how often the handler ran.
 */
function app() {
  const answers: { status: number; body: unknown }[] = [];
  let ran = 0;
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    c.set('tenantId', '00000000-0000-4000-8000-000000000001' as TenantId);
    await next();
  });
  hono.use('*', idempotencyMiddleware(createInMemoryIdempotencyStore()));
  hono.post('/v1/things', (c) => {
    ran += 1;
    const answer = answers.shift() ?? { status: 201, body: { ok: true } };
    return c.json(answer.body as object, answer.status as never);
  });
  const post = (key: string, body: object = { name: 'acme' }) =>
    hono.request('/v1/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
  return {
    post,
    answer: (status: number, body: unknown) => answers.push({ status, body }),
    ran: () => ran,
  };
}

describe('idempotencyMiddleware', () => {
  test('a request that took effect is replayed for the same key and body, marked X-Idempotent-Replay', async () => {
    const a = app();
    a.answer(201, { id: 'thing-1' });
    const first = await a.post('k1');
    const again = await a.post('k1');
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ id: 'thing-1' });
    expect(again.headers.get('X-Idempotent-Replay')).toBe('true');
    expect(first.headers.get('X-Idempotent-Replay')).toBeNull();
    expect(a.ran()).toBe(1);
  });

  test('a refusal (4xx) is not stored: the retry after fixing the cause runs, and succeeds', async () => {
    const a = app();
    a.answer(403, { error: { code: 'signer-not-trusted', message: 'not trusted' } });
    const refused = await a.post('k2');
    expect(refused.status).toBe(403);
    a.answer(201, { id: 'thing-2' });
    const retried = await a.post('k2');
    expect(retried.status).toBe(201);
    expect(retried.headers.get('X-Idempotent-Replay')).toBeNull();
    expect(a.ran()).toBe(2);
    // From then on, the success is what the key replays.
    expect((await a.post('k2')).headers.get('X-Idempotent-Replay')).toBe('true');
    expect(a.ran()).toBe(2);
  });

  test('a failure (5xx) is not stored either: a retry runs again', async () => {
    const a = app();
    a.answer(500, { error: { code: 'internal-server-error', message: 'database down' } });
    expect((await a.post('k3')).status).toBe(500);
    expect((await a.post('k3')).status).toBe(201);
    expect(a.ran()).toBe(2);
  });

  test('a stored key reused with another body is still refused (409), and nothing runs', async () => {
    const a = app();
    await a.post('k4', { name: 'acme' });
    const mismatch = await a.post('k4', { name: 'other' });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'idempotency-key-body-mismatch' },
    });
    expect(a.ran()).toBe(1);
  });
});
