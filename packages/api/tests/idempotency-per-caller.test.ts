// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An Idempotency-Key is the caller's: someone else in the tenant who sends
 * the same key and body runs the request themselves, and never gets another
 * caller's answer. A route whose answer carries a secret keeps none of it: a
 * repeat gets 409 `idempotency-key-replay-withheld`, with what succeeded and
 * when, instead of the secret or a second one (T392).
 */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import {
  type IdempotencyStore,
  type StoredIdempotencyEntry,
  createInMemoryIdempotencyStore,
  idempotencyMiddleware,
  withholdFromReplay,
} from '../src/middleware/idempotency.js';
import type { AppEnv } from '../src/types.js';

const SECRET = 'kgi_ak_acme_5f1e2d3c4b5a69788796a5b4';

/** Two routes behind the middleware, the caller from `x-test-user`; a store that records what it keeps. */
function app() {
  const kept: StoredIdempotencyEntry[] = [];
  const inner = createInMemoryIdempotencyStore();
  const store: IdempotencyStore = {
    get: (key) => inner.get(key),
    set: async (key, entry) => {
      kept.push(entry);
      await inner.set(key, entry);
    },
    ...(inner.holds !== undefined && { holds: inner.holds }),
  };
  let minted = 0;
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    c.set('tenantId', '00000000-0000-4000-8000-000000000001' as TenantId);
    const user = c.req.header('x-test-user');
    if (user !== undefined) c.set('userId', user as UserId);
    await next();
  });
  hono.use('*', idempotencyMiddleware(store));
  hono.post('/v1/things', async (c) => {
    minted += 1;
    return c.json({ id: `thing-${minted}`, by: c.get('userId') }, 201);
  });
  hono.post('/v1/keys', (c) => {
    minted += 1;
    withholdFromReplay(c);
    return c.json({ id: `key-${minted}`, token: `${SECRET}-${minted}` }, 201);
  });
  const post = (path: string, user: string, key: string, body: object = { name: 'acme' }) =>
    hono.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        'x-test-user': user,
      },
      body: JSON.stringify(body),
    });
  /** A credential that names no principal and no session (a deployment's own resolver). */
  const postWith = (credential: string, key: string) =>
    hono.request('/v1/things', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ name: 'acme' }),
    });
  return { post, postWith, kept, minted: () => minted };
}

describe('an Idempotency-Key is the caller’s', () => {
  test('another person with the same key and body runs it themselves: a miss, never a replay', async () => {
    const a = app();
    const alice = await a.post('/v1/things', 'u-alice', 'k-shared');
    const bob = await a.post('/v1/things', 'u-bob', 'k-shared');
    expect(await alice.json()).toEqual({ id: 'thing-1', by: 'u-alice' });
    expect(bob.headers.get('X-Idempotent-Replay')).toBeNull();
    expect(await bob.json()).toEqual({ id: 'thing-2', by: 'u-bob' });
    expect(a.minted()).toBe(2);
  });

  test('the same person repeating is still replayed', async () => {
    const a = app();
    await a.post('/v1/things', 'u-alice', 'k1');
    const again = await a.post('/v1/things', 'u-alice', 'k1');
    expect(again.headers.get('X-Idempotent-Replay')).toBe('true');
    expect(await again.json()).toEqual({ id: 'thing-1', by: 'u-alice' });
    expect(a.minted()).toBe(1);
  });

  test('a credential with no principal or session is its own caller: never a bucket shared with another', async () => {
    const a = app();
    await a.postWith('kgi_bt_acme_one', 'k-shared');
    const other = await a.postWith('kgi_bt_acme_two', 'k-shared');
    expect(other.headers.get('X-Idempotent-Replay')).toBeNull();
    expect(((await other.json()) as { id: string }).id).toBe('thing-2');
    const same = await a.postWith('kgi_bt_acme_one', 'k-shared');
    expect(same.headers.get('X-Idempotent-Replay')).toBe('true');
    expect(((await same.json()) as { id: string }).id).toBe('thing-1');
  });

  test("another person never gets a secret-bearing answer either: it's their own request", async () => {
    const a = app();
    await a.post('/v1/keys', 'u-alice', 'k-shared');
    const bob = await a.post('/v1/keys', 'u-bob', 'k-shared');
    expect(bob.status).toBe(201);
    expect(await bob.json()).toEqual({ id: 'key-2', token: `${SECRET}-2` });
  });
});

describe('an answer that carries a secret (withholdFromReplay)', () => {
  test('is not kept: only that it succeeded, and when', async () => {
    const a = app();
    const first = await a.post('/v1/keys', 'u-alice', 'k1');
    expect(first.status).toBe(201);
    expect(((await first.json()) as { token: string }).token).toBe(`${SECRET}-1`);
    expect(a.kept).toHaveLength(1);
    expect(a.kept[0]).toMatchObject({ status: 201, bodyText: '', withheld: true });
    expect(JSON.stringify(a.kept)).not.toContain(SECRET);
  });

  test('a repeat gets 409 replay-withheld with the status and when, no secret, and nothing runs again', async () => {
    const a = app();
    await a.post('/v1/keys', 'u-alice', 'k1');
    const again = await a.post('/v1/keys', 'u-alice', 'k1');
    expect(again.status).toBe(409);
    const text = await again.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as {
      error: { code: string; message: string; details: { status: number; at: string } };
    };
    expect(body.error.code).toBe('idempotency-key-replay-withheld');
    expect(body.error.details.status).toBe(201);
    expect(Date.now() - Date.parse(body.error.details.at)).toBeLessThan(60_000);
    expect(body.error.message).toContain('succeeded (201');
    expect(a.minted()).toBe(1);
  });

  test('a repeat with another body is still a body mismatch', async () => {
    const a = app();
    await a.post('/v1/keys', 'u-alice', 'k1');
    const other = await a.post('/v1/keys', 'u-alice', 'k1', { name: 'other' });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe(
      'idempotency-key-body-mismatch',
    );
  });
});
