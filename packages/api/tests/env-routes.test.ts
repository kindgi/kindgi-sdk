// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { EnvName, TenantId } from '@kindgi/types';
import { makeEnvName } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { EnvBinding, EnvRecord, RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * `/v1/env/*` route tests — the HTTP surface for
 * `EnvBinding`. Exercises:
 *   - happy path list / get / put / delete
 *   - envName + scope required + cross-field validation
 *   - `ifRevision` conflict → 409 `env-write-conflict`
 *   - cross-env structural refusal (staging cannot see production)
 *   - `env:write` capability gate → 403 permission-denied
 */

const tenantA: TenantId = 'ten-a' as unknown as TenantId;
const staging: EnvName = makeEnvName('staging') as EnvName;
const prod: EnvName = makeEnvName('production') as EnvName;

const TOKEN_WRITE = 'token-with-env-write';
const TOKEN_RO = 'token-readonly';

const resolveToken: TokenResolver = async (t) => {
  if (t === TOKEN_WRITE) {
    return { tenantId: tenantA, capabilities: ['env:write'] };
  }
  if (t === TOKEN_RO) {
    return { tenantId: tenantA, capabilities: [] };
  }
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

/**
 * Small in-memory EnvBinding fixture keyed on
 * `(scopeKey || envName || name)`. Not the reference adapter — the
 * routes are what's under test.
 */
function makeInMemoryEnvBinding(): EnvBinding {
  const rows = new Map<string, EnvRecord>();
  const key = (scope: Scope, envName: EnvName, name: string): string =>
    `${scopeKeyString(scope)}::${envName as unknown as string}::${name}`;
  let seq = 0;
  return {
    async list(input) {
      const out: EnvRecord[] = [];
      for (const row of rows.values()) {
        if (scopeKeyString(row.scope) !== scopeKeyString(input.scope)) continue;
        if (row.envName !== input.envName) continue;
        if (
          input.namePrefix !== undefined &&
          input.namePrefix.length > 0 &&
          !row.name.startsWith(input.namePrefix)
        ) {
          continue;
        }
        out.push(row);
      }
      out.sort((a, b) => (a.name < b.name ? -1 : 1));
      return { data: out.slice(0, input.limit) };
    },
    async get(input) {
      return rows.get(key(input.scope, input.envName, input.name)) ?? null;
    },
    async resolve(input) {
      const row = rows.get(key(input.scope, input.envName, input.name));
      if (row === undefined) {
        return {
          kind: 'err',
          error: { code: 'env-not-found', message: 'unknown', name: input.name },
        };
      }
      return { kind: 'ok', value: { name: row.name, value: row.value, revision: row.revision } };
    },
    async set(input) {
      const k = key(input.scope, input.envName, input.name);
      const existing = rows.get(k);
      if (input.ifRevision !== undefined) {
        const current = existing?.revision ?? 0;
        if (current !== input.ifRevision) {
          return { kind: 'revision-conflict', currentRevision: current };
        }
      }
      seq += 1;
      const rec: EnvRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        value: input.value,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? new Date(Date.now() + seq).toISOString(),
        updatedAt: new Date(Date.now() + seq).toISOString(),
        ...(input.tags !== undefined && { tags: input.tags }),
      };
      rows.set(k, rec);
      return { kind: 'ok', record: rec };
    },
    async delete(input) {
      const k = key(input.scope, input.envName, input.name);
      const had = rows.delete(k);
      return { deleted: had };
    },
  };
}

function scopeKeyString(s: Scope): string {
  switch (s.kind) {
    case 'tenant':
      return `tenant:${s.tenantId as unknown as string}`;
    case 'org':
      return `org:${s.tenantId as unknown as string}:${s.orgId as unknown as string}`;
    case 'project':
      return `project:${s.tenantId as unknown as string}:${s.projectId as unknown as string}`;
    default:
      return 'unknown';
  }
}

function makeApp(overrides?: { envBinding?: EnvBinding }): ReturnType<typeof createApp> {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(overrides?.envBinding !== undefined && { envBinding: overrides.envBinding }),
  });
}

describe('API — /v1/env — mounting', () => {
  test('routes 404 when envBinding is unwired', async () => {
    const app = makeApp();
    const res = await app.request('/v1/env?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — GET /v1/env — validation', () => {
  test('missing envName → 400 env-name-required', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env?scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('env-name-required');
  });

  test('missing scopeKind → 400 scope-kind-required', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env?envName=staging', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-kind-required');
  });

  test('scopeKind=tenant with scopeId → 400 scope-invalid', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env?envName=staging&scopeKind=tenant&scopeId=oops', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(res.status).toBe(400);
  });

  test('scopeKind=project without scopeId → 400', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env?envName=staging&scopeKind=project', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(res.status).toBe(400);
  });

  test('invalid envName grammar → 400 env-name-required', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env?envName=BAD_UPPERCASE&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('env-name-required');
  });
});

describe('API — /v1/env — happy path', () => {
  test('PUT + GET + LIST + DELETE full cycle', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });

    // PUT
    const put = await app.request('/v1/env/KB_URL?envName=staging&scopeKind=tenant', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'https://kb.example.com' }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as {
      name: string;
      value: string;
      revision: number;
    };
    expect(putBody.name).toBe('KB_URL');
    expect(putBody.value).toBe('https://kb.example.com');
    expect(putBody.revision).toBe(1);

    // GET
    const get = await app.request('/v1/env/KB_URL?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { name: string; value: string };
    expect(getBody.value).toBe('https://kb.example.com');

    // LIST
    const list = await app.request('/v1/env?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ name: string; value: string }> };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.name).toBe('KB_URL');
    expect(listBody.data[0]?.value).toBe('https://kb.example.com');

    // DELETE
    const del = await app.request('/v1/env/KB_URL?envName=staging&scopeKind=tenant', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { deleted: boolean };
    expect(delBody.deleted).toBe(true);

    // GET after delete → 404
    const gone = await app.request('/v1/env/KB_URL?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(gone.status).toBe(404);
    const goneBody = (await gone.json()) as { error: { code: string } };
    expect(goneBody.error.code).toBe('env-not-found');
  });

  test('idempotent delete on unknown key → 200 { deleted: false }', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env/NEVER_EXISTED?envName=staging&scopeKind=tenant', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(false);
  });
});

describe('API — PUT /v1/env — cross-field + conflict', () => {
  test('body envName mismatch → 400 env-name-mismatch', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env/K?envName=staging&scopeKind=tenant', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ envName: 'production', value: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('env-name-mismatch');
  });

  test('ifRevision conflict → 409 env-write-conflict', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });

    await app.request('/v1/env/K?envName=staging&scopeKind=tenant', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'first' }),
    });
    const conflict = await app.request('/v1/env/K?envName=staging&scopeKind=tenant', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'second', ifRevision: 99 }),
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as {
      error: { code: string; details?: { currentRevision?: number } };
    };
    expect(body.error.code).toBe('env-write-conflict');
    expect(body.error.details?.currentRevision).toBe(1);
  });

  test('missing env:write capability → 403 permission-denied', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    const res = await app.request('/v1/env/K?envName=staging&scopeKind=tenant', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN_RO}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'nope' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('permission-denied');
  });
});

describe('API — /v1/env — cross-env structural refusal', () => {
  test('writes in staging never surface in production', async () => {
    const env = makeInMemoryEnvBinding();
    const app = makeApp({ envBinding: env });
    // Write in staging.
    await app.request('/v1/env/K?envName=staging&scopeKind=tenant', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'staging-value' }),
    });
    // Read in production.
    const prodList = await app.request('/v1/env?envName=production&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE}` },
    });
    const prodBody = (await prodList.json()) as { data: unknown[] };
    expect(prodBody.data).toEqual([]);
    void staging;
    void prod;
  });
});
