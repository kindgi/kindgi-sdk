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

import { createStubAppBindings } from '../src/testing/index.js';

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
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, capabilities: ['env:write', 'secrets:write'] } : null;
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

function envRows(n: number, under: EnvName = envName, prefix = 'ENV'): EnvRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    scope,
    envName: under,
    name: `${prefix}_${String(i).padStart(2, '0')}`,
    value: `v${i}`,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  }));
}

function secretRows(n: number, under: EnvName = envName): SecretRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    scope,
    envName: under,
    name: `SECRET_${String(i).padStart(2, '0')}`,
    currentVersion: 1,
    createdAt: at,
    updatedAt: at,
  }));
}

/** Each binding lists the rows under the env asked for; `served`: the env the runtime serves. */
function appWith(env: readonly EnvRecord[], secrets: readonly SecretRecord[], served?: EnvName) {
  const under = <T extends { readonly envName: EnvName }>(rows: readonly T[], at: EnvName) =>
    rows.filter((r) => r.envName === at);
  const envBinding = {
    list: async (input) => listOver(under(env, input.envName), input),
  } as EnvBinding;
  const secretsBinding = {
    list: async (input) => listOver(under(secrets, input.envName), input),
  } as SecretBinding;
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    envBinding,
    secretsBinding,
    ...(served !== undefined && { envName: served }),
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

  test("on a runtime serving another env: its values, then the tenant's settings under `default`, then its secrets, each once", async () => {
    const prod = 'prod' as EnvName;
    const values = envRows(7, prod);
    const settings = envRows(4, envName, 'SETTING');
    const app = appWith([...values, ...settings], secretRows(5, prod), prod);
    const pages = await readAll(app, 'limit=4');
    expect(pages.map((p) => p.data.length)).toEqual([4, 4, 4, 4]);
    expect(pages.flatMap((p) => p.data.map((e) => [e.kind, e.key]))).toEqual([
      ...values.map((r) => ['env', r.name]),
      ...settings.map((r) => ['config', r.name]),
      ...secretRows(5).map((r) => ['secret', r.name]),
    ]);
    // `?kind=` narrows to one of them; the values never list as settings.
    const only = async (kind: string) =>
      (await readAll(app, `kind=${kind}&limit=3`)).flatMap((p) => p.data.map((e) => e.key));
    expect(await only('config')).toEqual(settings.map((r) => r.name));
    expect(await only('env')).toEqual(values.map((r) => r.name));
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

describe('PATCH /v1/tenant/config — a secret write the store refuses', () => {
  test.each([
    ['secret-name-invalid', 400],
    ['reserved-name-prefix', 400],
    ['secret-value-too-large', 400],
    ['secret-value-invalid', 400],
    ['secret-provider-rate-limited', 429],
    ['secret-provider-unauthorized', 502],
    ['secret-provider-unavailable', 503],
    ['secret-store-error', 500],
  ])('%s answers %i, as on POST /v1/secrets', async (code, status) => {
    const secretsBinding = {
      get: async () => null,
      set: async () => ({ kind: 'error', code, message: 'the store says why' }),
    } as unknown as SecretBinding;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      secretsBinding,
    });
    const res = await app.request('/v1/tenant/config', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'secret', key: 'acme-key', value: 'v' }),
    });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });
});

describe('PATCH /v1/tenant/config — the capability of the binding it writes', () => {
  /** Keys by the capabilities they carry. */
  const KEYS: Record<string, readonly string[]> = {
    'env-key': ['env:write'],
    'secrets-key': ['secrets:write'],
    'bare-key': [],
  };

  /** Bindings that note each call: an env write lands, and the store refuses a secret. */
  function writer() {
    const calls: string[] = [];
    const envBinding = {
      set: async (input: { readonly name: string }) => {
        calls.push(`env.set ${input.name}`);
        return { kind: 'ok', record: { value: 'v', revision: 1, updatedAt: at } };
      },
    } as unknown as EnvBinding;
    const secretsBinding = {
      get: async () => {
        calls.push('secrets.get');
        return null;
      },
      set: async () => {
        calls.push('secrets.set');
        return { kind: 'error', code: 'secret-store-error', message: 'the store says why' };
      },
    } as unknown as SecretBinding;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async (token) => {
        const capabilities = KEYS[token];
        return capabilities === undefined ? null : { tenantId, capabilities };
      },
      runHandler: {} as RunHandlerBinding,
      envBinding,
      secretsBinding,
    });
    const patch = (token: string, body: Record<string, unknown>) =>
      app.request('/v1/tenant/config', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { calls, patch };
  }

  test.each([
    ['an env entry, with none', 'bare-key', { kind: 'env', key: 'ACME_URL' }, 'env:write'],
    ['a config entry, with none', 'bare-key', { kind: 'config', key: 'ACME_MODE' }, 'env:write'],
    ['a secret, with none', 'bare-key', { kind: 'secret', key: 'ACME_KEY' }, 'secrets:write'],
    ['a secret, with env:write', 'env-key', { kind: 'secret', key: 'ACME_KEY' }, 'secrets:write'],
    [
      'a sensitive config entry, with env:write',
      'env-key',
      { kind: 'config', key: 'ACME_KEY', sensitive: true },
      'secrets:write',
    ],
    // Before the store is read: a new name it would refuse answers as any other.
    [
      'a bad new secret name, with env:write',
      'env-key',
      { kind: 'secret', key: '.x' },
      'secrets:write',
    ],
    [
      'an env entry, with secrets:write',
      'secrets-key',
      { kind: 'env', key: 'ACME_URL' },
      'env:write',
    ],
    [
      'a config entry, with secrets:write',
      'secrets-key',
      { kind: 'config', key: 'ACME_MODE' },
      'env:write',
    ],
  ])('%s: 403 for want of %s, and no binding is called', async (_, token, entry, cap) => {
    const { calls, patch } = writer();
    const res = await patch(token, { ...entry, value: 'v' });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain(`\`${cap}\``);
    expect(calls).toEqual([]);
  });

  test('env:write writes an env or config entry, and secrets:write a secret', async () => {
    const { calls, patch } = writer();
    const env = await patch('env-key', { kind: 'env', key: 'ACME_URL', value: 'v' });
    const config = await patch('env-key', { kind: 'config', key: 'ACME_MODE', value: 'v' });
    expect([env.status, config.status]).toEqual([200, 200]);
    // The store's own refusal: the check let the write through to it.
    const secret = await patch('secrets-key', { kind: 'secret', key: 'ACME_KEY', value: 'v' });
    expect(secret.status).toBe(500);
    expect(calls).toEqual(['env.set ACME_URL', 'env.set ACME_MODE', 'secrets.get', 'secrets.set']);
  });
});
