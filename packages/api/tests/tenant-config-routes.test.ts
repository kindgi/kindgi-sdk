// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/tenant/config` paging across the env and secrets bindings:
 * no page exceeds `limit`, `hasMore` / `nextCursor` stay honest, and
 * following the cursor returns every entry of both bindings exactly
 * once.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, EnvName, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  EnvBinding,
  EnvRecord,
  RunHandlerBinding,
  SecretBinding,
  SecretRecord,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'tenant-config-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const envName = 'default' as EnvName;
const scope = { kind: 'tenant' as const, tenantId };
const at = '2026-09-30T00:00:00.000Z';

/** Offset-cursor list over a fixed array, honoring `limit` and `namePrefix`. */
function listOver<T extends { readonly name: string }>(
  rows: readonly T[],
  input: { readonly limit: number; readonly cursor?: Cursor; readonly namePrefix?: string },
): { readonly data: readonly T[]; readonly nextCursor?: Cursor } {
  const matching = rows.filter((r) => r.name.startsWith(input.namePrefix ?? ''));
  const start = input.cursor === undefined ? 0 : Number(input.cursor);
  const data = matching.slice(start, start + input.limit);
  const next = start + data.length;
  return next < matching.length ? { data, nextCursor: String(next) as Cursor } : { data };
}

function envRows(n: number): EnvRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    scope,
    envName,
    name: `ENV_${String(i).padStart(2, '0')}`,
    value: `v${i}`,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  }));
}

function secretRows(n: number): SecretRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    scope,
    envName,
    name: `SECRET_${String(i).padStart(2, '0')}`,
    currentVersion: 1,
    createdAt: at,
    updatedAt: at,
  }));
}

function appWith(env: readonly EnvRecord[], secrets: readonly SecretRecord[]) {
  const envBinding = { list: async (input) => listOver(env, input) } as EnvBinding;
  const secretsBinding = { list: async (input) => listOver(secrets, input) } as SecretBinding;
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    envBinding,
    secretsBinding,
  });
}

interface Page {
  readonly data: readonly { readonly kind: string; readonly key: string }[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

async function readAll(app: ReturnType<typeof appWith>, query: string): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const sep = query.length > 0 ? '&' : '';
    const res = await app.request(
      `/v1/tenant/config?${query}${cursor !== undefined ? `${sep}cursor=${cursor}` : ''}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    pages.push(page);
    expect(page.hasMore).toBe(page.nextCursor !== undefined);
    cursor = page.nextCursor;
    if (pages.length > 20) throw new Error('paging did not terminate');
  } while (cursor !== undefined);
  return pages;
}

describe('GET /v1/tenant/config — paging across env + secrets', () => {
  test('pages never exceed limit and cover every entry once', async () => {
    const app = appWith(envRows(30), secretRows(20));
    const pages = await readAll(app, 'limit=25');

    expect(pages.map((p) => p.data.length)).toEqual([25, 25]);
    const keys = pages.flatMap((p) => p.data.map((e) => e.key));
    expect(keys).toEqual([...envRows(30).map((r) => r.name), ...secretRows(20).map((r) => r.name)]);
    expect(pages.at(-1)?.hasMore).toBe(false);
  });

  test('an env page that ends exactly at the boundary still reports secrets', async () => {
    const app = appWith(envRows(10), secretRows(3));
    const pages = await readAll(app, 'limit=10');
    expect(pages.map((p) => p.data.length)).toEqual([10, 3]);
    expect(pages[0]?.hasMore).toBe(true);
  });

  test('no trailing empty page when the secrets binding has nothing', async () => {
    const app = appWith(envRows(10), []);
    const pages = await readAll(app, 'limit=10');
    expect(pages.map((p) => p.data.length)).toEqual([10]);
    expect(pages[0]?.hasMore).toBe(false);
  });

  test('?kind=secret pages the secrets binding alone', async () => {
    const app = appWith(envRows(5), secretRows(7));
    const pages = await readAll(app, 'kind=secret&limit=3');
    expect(pages.map((p) => p.data.length)).toEqual([3, 3, 1]);
    expect(pages.flatMap((p) => p.data.map((e) => e.kind))).toEqual(Array(7).fill('secret'));
  });

  test('a malformed cursor is 400 bad-input', async () => {
    const app = appWith(envRows(1), secretRows(1));
    const res = await app.request('/v1/tenant/config?cursor=not-a-cursor', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
  });
});
