// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Cursors sealed at the API's edge (`cursorSealer`): what a list hands out
 * opens only for the same caller, list and filters, as it was; anything
 * else sealed is `400 bad-input`; a plain cursor still passes.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createAeadCursorSealer, createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const users: Readonly<Record<string, string>> = { 'token-1': 'user-1', 'token-2': 'user-2' };
const resolveToken: TokenResolver = async (token) =>
  users[token] !== undefined ? { tenantId, userId: users[token] as UserId } : null;

const POSITION = Buffer.from(JSON.stringify({ a: 'acme.last' })).toString('base64url');

function harness() {
  const cursors: (string | undefined)[] = [];
  const agentRegistry = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'then') return undefined;
        if (name !== 'list') return undefined;
        return async (input: { cursor?: string }) => {
          cursors.push(input.cursor);
          return { data: [], nextCursor: POSITION };
        };
      },
    },
  ) as never;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentRegistry,
    cursorSealer: createAeadCursorSealer({ keys: [{ kid: 'k', key: new Uint8Array(32).fill(3) }] }),
  });
  const get = async (path: string, token = 'token-1') => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { get, cursors };
}

describe('sealed page cursors', () => {
  test('a list hands out its cursor sealed, and takes it back as the position it was', async () => {
    const { get, cursors } = harness();
    const first = await get('/v1/agents?name=acme&limit=5');
    expect(first.status).toBe(200);
    const sealed = first.body.nextCursor as string;
    expect(sealed.startsWith('k1.k.')).toBe(true);
    expect(sealed).not.toContain(POSITION);
    // The page size may change mid-scan; the filters may not.
    const second = await get(`/v1/agents?limit=2&name=acme&cursor=${encodeURIComponent(sealed)}`);
    expect(second.status).toBe(200);
    expect(cursors).toEqual([undefined, POSITION]);
  });

  test.each([
    ['other filters', (c: string) => `/v1/agents?name=other&cursor=${c}`, 'token-1'],
    ['another caller', (c: string) => `/v1/agents?name=acme&cursor=${c}`, 'token-2'],
    ['another list', (c: string) => `/v1/conversations?name=acme&cursor=${c}`, 'token-1'],
  ])('one taken elsewhere (%s) is 400 bad-input, before any binding', async (_w, path, token) => {
    const { get, cursors } = harness();
    const sealed = (await get('/v1/agents?name=acme')).body.nextCursor as string;
    const res = await get(path(encodeURIComponent(sealed)), token);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'bad-input' });
    expect(res.body.error.message).toContain("isn't from this list");
    expect(cursors).toHaveLength(1);
  });

  test('one sealed with a key this runtime lacks says so (a restart, a rotation)', async () => {
    const { get, cursors } = harness();
    const other = createAeadCursorSealer({
      keys: [{ kid: 'gone', key: new Uint8Array(32).fill(9) }],
    });
    const sealed = other.seal(POSITION, {
      tenantId,
      principal: 'user:user-1',
      list: '/v1/agents',
      filters: '[]',
    });
    const res = await get(`/v1/agents?cursor=${encodeURIComponent(sealed)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("a key this runtime doesn't have");
    expect(cursors).toEqual([]);
  });

  test('one tampered with is refused; a plain one still passes, as it is', async () => {
    const { get, cursors } = harness();
    const sealed = (await get('/v1/agents')).body.nextCursor as string;
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('A') ? 'B' : 'A'}A`;
    expect((await get(`/v1/agents?cursor=${encodeURIComponent(tampered)}`)).status).toBe(400);
    const plain = await get(`/v1/agents?cursor=${POSITION}`);
    expect(plain.status).toBe(200);
    expect(cursors).toEqual([undefined, POSITION]);
  });

  test('an error answer, or a caller nobody knows, is left as it was', async () => {
    const { get, cursors } = harness();
    const refused = await get('/v1/agents?scopeKind=nowhere');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).not.toBe('bad-input');
    expect((await get('/v1/agents', 'token-none')).status).toBe(401);
    expect(cursors).toEqual([]);
  });
});
