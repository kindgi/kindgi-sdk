// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import {
  type IdempotencyStore,
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

/**
 * A route whose handler waits until the test lets it answer, so a repeat
 * can arrive while the first request still runs (T349).
 */
function slowApp(
  opts: { store?: IdempotencyStore; holdMs?: number; status?: number; throws?: boolean } = {},
) {
  const store = opts.store ?? createInMemoryIdempotencyStore();
  let ran = 0;
  const entered: (() => void)[] = [];
  const gates: (() => void)[] = [];
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    c.set('tenantId', '00000000-0000-4000-8000-000000000001' as TenantId);
    await next();
  });
  hono.use(
    '*',
    idempotencyMiddleware(store, opts.holdMs === undefined ? {} : { holdMs: opts.holdMs }),
  );
  hono.post('/v1/runs', async (c) => {
    ran += 1;
    const run = ran;
    entered.shift()?.();
    await new Promise<void>((resolve) => gates.push(resolve));
    if (opts.throws === true) throw new Error('the handler failed');
    return c.json({ id: `run-${run}` }, (opts.status ?? 201) as never);
  });
  const post = (key: string, body: object = { flow: 'acme.slow' }) =>
    hono.request('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
  /**
   * Start a request; resolves once its handler is running, with the answer
   * still pending (wrapped, so awaiting this doesn't wait for the answer).
   */
  const started = async (key: string, body?: object) => {
    const inside = new Promise<void>((resolve) => entered.push(resolve));
    const answer = post(key, body);
    await inside;
    return { answer };
  };
  return { store, post, started, release: () => gates.shift()?.(), ran: () => ran };
}

describe('idempotencyMiddleware: a key is held while its request runs (T349)', () => {
  test('a repeat while the first runs gets 409 idempotency-key-in-flight with Retry-After; once it answers, the repeat gets its answer', async () => {
    const a = slowApp();
    const { answer: first } = await a.started('k1');
    const repeat = await a.post('k1');
    expect(repeat.status).toBe(409);
    expect(repeat.headers.get('Retry-After')).toBe('5');
    const body = (await repeat.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('idempotency-key-in-flight');
    expect(body.error.message).toBe(
      "A request with this Idempotency-Key is still running. Retry after it answers (Retry-After), and you'll get its answer.",
    );

    a.release();
    expect((await first).status).toBe(201);
    const after = await a.post('k1');
    expect(after.status).toBe(201);
    expect(await after.json()).toEqual({ id: 'run-1' });
    expect(after.headers.get('X-Idempotent-Replay')).toBe('true');
    expect(a.ran()).toBe(1);
  });

  test('another body under a key in flight is a body mismatch, not a run', async () => {
    const a = slowApp();
    const { answer: first } = await a.started('k1');
    const other = await a.post('k1', { flow: 'acme.other' });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe(
      'idempotency-key-body-mismatch',
    );
    a.release();
    await first;
    expect(a.ran()).toBe(1);
  });

  test('a refusal releases the hold: a retry runs', async () => {
    const a = slowApp({ status: 422 });
    const { answer: first } = await a.started('k1');
    a.release();
    expect((await first).status).toBe(422);
    const { answer: retry } = await a.started('k1');
    a.release();
    expect((await retry).status).toBe(422);
    expect(a.ran()).toBe(2);
  });

  test('a handler that throws releases the hold: a retry runs', async () => {
    const a = slowApp({ throws: true });
    const { answer: first } = await a.started('k1');
    a.release();
    expect((await first).status).toBe(500);
    const { answer: retry } = await a.started('k1');
    a.release();
    await retry;
    expect(a.ran()).toBe(2);
  });

  test('the hold is renewed while the request runs, past holdMs', async () => {
    const a = slowApp({ holdMs: 60 });
    const { answer: first } = await a.started('k1');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const repeat = await a.post('k1');
    expect(repeat.status).toBe(409);
    a.release();
    await first;
    expect(a.ran()).toBe(1);
  });

  test("a crashed request's hold lapses: the next request runs", async () => {
    const a = slowApp({ holdMs: 60 });
    // A hold whose request died: nothing renews it.
    await a.store.holds?.hold('00000000-0000-4000-8000-000000000001|POST:/v1/runs|k1', {
      holder: 'gone',
      bodyHash: 'whatever',
      expiresAt: Date.now() + 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const { answer: next } = await a.started('k1');
    a.release();
    expect((await next).status).toBe(201);
    expect(a.ran()).toBe(1);
  });

  test('a store without holds holds nothing: a repeat in flight runs again (before 0.1.5)', async () => {
    const memory = createInMemoryIdempotencyStore();
    const a = slowApp({ store: { get: memory.get, set: memory.set } });
    const { answer: first } = await a.started('k1');
    const { answer: repeat } = await a.started('k1');
    a.release();
    a.release();
    expect((await first).status).toBe(201);
    expect((await repeat).status).toBe(201);
    expect(a.ran()).toBe(2);
  });

  test('the in-memory store keeps the first answer: a later set never replaces it', async () => {
    const store = createInMemoryIdempotencyStore();
    const entry = (bodyText: string) => ({
      bodyHash: 'h',
      status: 201,
      contentType: 'application/json',
      bodyText,
      expiresAt: Date.now() + 60_000,
    });
    await store.set('k', entry('first'));
    await store.set('k', entry('second'));
    expect((await store.get('k'))?.bodyText).toBe('first');
    expect(
      await store.holds?.hold('k', { holder: 'x', bodyHash: 'h', expiresAt: Date.now() + 1000 }),
    ).toEqual({
      kind: 'stored',
      entry: entry('first'),
    });
  });
});
