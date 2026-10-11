// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { makeInMemoryOrgBinding } from '@kindgi/platform';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * Orgs route tests.
 *
 * Wires the reference in-memory `OrgBinding` from `@kindgi/platform`;
 * no DB access. Covers happy-path CRUD, cross-tenant isolation, 404
 * shapes, pagination via cursor.
 */

const TOKEN_A = 'orgs-token-tenant-a';
const TOKEN_B = 'orgs-token-tenant-b';
const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN_A) return { tenantId: tenantA };
  if (token === TOKEN_B) return { tenantId: tenantB };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

function makeApp() {
  const orgBinding = makeInMemoryOrgBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    orgBinding,
  });
  return { app, orgBinding };
}

describe('API — orgs list', () => {
  test('empty binding → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/orgs', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('nameContains filter', async () => {
    const { app } = makeApp();
    for (const name of ['Acme', 'Acme HR', 'Globex']) {
      const res = await app.request('/v1/orgs', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, slug: name.toLowerCase().replace(/ /g, '-') }),
      });
      expect(res.status).toBe(201);
    }
    const res = await app.request('/v1/orgs?nameContains=Acme', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }> };
    const names = body.data.map((o) => o.name).sort();
    expect(names).toEqual(['Acme', 'Acme HR']);
  });

  test('cursor pagination', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 5; i += 1) {
      await app.request('/v1/orgs', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: `Org ${i}`, slug: `org-${i}` }),
      });
    }
    const first = await app.request('/v1/orgs?limit=2', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const firstBody = (await first.json()) as {
      data: unknown[];
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/orgs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN_A}` } },
    );
    const secondBody = (await second.json()) as {
      data: unknown[];
      hasMore: boolean;
    };
    expect(secondBody.data).toHaveLength(2);
    expect(secondBody.hasMore).toBe(true);
  });
});

describe('API — orgs create + get', () => {
  test('POST /v1/orgs → 201 { id }', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'My Org', slug: 'my-org' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeTruthy();
  });

  test('GET /:orgId roundtrip', async () => {
    const { app } = makeApp();
    const create = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Foo', slug: 'foo' }),
    });
    const { id } = (await create.json()) as { id: string };
    const get = await app.request(`/v1/orgs/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { id: string; name: string; slug: string };
    expect(body.id).toBe(id);
    expect(body.name).toBe('Foo');
    expect(body.slug).toBe('foo');
  });

  test('unknown orgId → 404 org-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/orgs/no-such-org', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('org-not-found');
  });

  test('POST /v1/orgs — missing name → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ slug: 'no-name' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('POST /v1/orgs — non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('API — orgs patch', () => {
  test('PATCH /:orgId → 204, name updated', async () => {
    const { app } = makeApp();
    const create = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Old', slug: 'old' }),
    });
    const { id } = (await create.json()) as { id: string };
    const patch = await app.request(`/v1/orgs/${id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'New' }),
    });
    expect(patch.status).toBe(204);
    const get = await app.request(`/v1/orgs/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const body = (await get.json()) as { name: string; slug: string };
    expect(body.name).toBe('New');
    expect(body.slug).toBe('old');
  });

  test('PATCH unknown orgId → 404 org-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/orgs/no-such-org', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('org-not-found');
  });

  test('PATCH with non-string field → 400', async () => {
    const { app } = makeApp();
    const create = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'x', slug: 'x' }),
    });
    const { id } = (await create.json()) as { id: string };
    const res = await app.request(`/v1/orgs/${id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('API — orgs delete', () => {
  test('DELETE known → 204; subsequent GET → 404', async () => {
    const { app } = makeApp();
    const create = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'To Delete', slug: 'to-delete' }),
    });
    const { id } = (await create.json()) as { id: string };
    const del = await app.request(`/v1/orgs/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(del.status).toBe(204);
    const get = await app.request(`/v1/orgs/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(get.status).toBe(404);
  });

  test('DELETE unknown → 204 (idempotent)', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/orgs/no-such-org', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(204);
  });
});

describe('API — orgs cross-tenant isolation', () => {
  test('tenant B never sees tenant A rows', async () => {
    const { app } = makeApp();
    const create = await app.request('/v1/orgs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Alpha', slug: 'alpha' }),
    });
    const { id } = (await create.json()) as { id: string };

    // List under B — empty.
    const list = await app.request('/v1/orgs', {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    const listBody = (await list.json()) as { data: unknown[] };
    expect(listBody.data).toEqual([]);

    // Direct get under B — 404, even though the id exists under A.
    const get = await app.request(`/v1/orgs/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    expect(get.status).toBe(404);
  });
});

describe('API — orgs surface unmounted when no binding supplied', () => {
  test('no `orgBinding` → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/orgs', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
  });
});
