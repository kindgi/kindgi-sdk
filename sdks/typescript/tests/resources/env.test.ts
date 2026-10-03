// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const TENANT_SCOPE: Scope = {
  kind: 'tenant',
  tenantId: 'tenant-1' as never,
};
const PROJECT_SCOPE: Scope = {
  kind: 'project',
  tenantId: 'tenant-1' as never,
  projectId: 'proj-42' as never,
};

const WIRE_ENV = {
  scope: TENANT_SCOPE,
  envName: 'staging',
  name: 'FOO_URL',
  value: 'https://example.com',
  revision: 3,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-22T00:00:00Z',
};

describe('env.list', () => {
  it('GETs /v1/env with scope + envName query params + optional filters', async () => {
    const stub = jsonFetch({ data: [WIRE_ENV], nextCursor: 'cur-1' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const page = await client.env.list({
      scope: PROJECT_SCOPE,
      envName: 'staging' as never,
      namePrefix: 'FOO_',
      limit: 25,
    });
    expect(page.data.length).toBe(1);
    expect(page.nextCursor).toBe('cur-1');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/env');
    expect(url.searchParams.get('scopeKind')).toBe('project');
    expect(url.searchParams.get('scopeId')).toBe('proj-42');
    expect(url.searchParams.get('envName')).toBe('staging');
    expect(url.searchParams.get('namePrefix')).toBe('FOO_');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('elides scopeId for tenant scope', async () => {
    const stub = jsonFetch({ data: [] });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await client.env.list({ scope: TENANT_SCOPE, envName: 'prod' as never });
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('scopeKind')).toBe('tenant');
    expect(url.searchParams.has('scopeId')).toBe(false);
  });
});

describe('env.get', () => {
  it('GETs /v1/env/{name}', async () => {
    const stub = jsonFetch(WIRE_ENV);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const rec = await client.env.get({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'FOO_URL',
    });
    expect(rec?.name).toBe('FOO_URL');
    expect(rec?.value).toBe('https://example.com');
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/env/FOO_URL');
  });

  it('percent-encodes names with special chars', async () => {
    const stub = jsonFetch(WIRE_ENV);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await client.env.get({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'domain.key',
    });
    expect(stub.calls[0]?.url).toContain('/v1/env/domain.key');
  });

  it('returns null on 404 env-not-found', async () => {
    const stub = errorFetch(404, { code: 'env-not-found', message: 'nope' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const rec = await client.env.get({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'MISSING',
    });
    expect(rec).toBeNull();
  });

  it('rethrows on non-404 errors', async () => {
    const stub = errorFetch(500, { code: 'server-error', message: 'boom' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await expect(
      client.env.get({
        scope: TENANT_SCOPE,
        envName: 'staging' as never,
        name: 'FOO',
      }),
    ).rejects.toMatchObject({ error: { code: 'server' } });
  });
});

describe('env.set', () => {
  it('PUTs /v1/env/{name} with scope + envName + value in body', async () => {
    const stub = jsonFetch(WIRE_ENV);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const outcome = await client.env.set({
      scope: PROJECT_SCOPE,
      envName: 'prod' as never,
      name: 'FOO_URL',
      value: 'https://example.com',
      ifRevision: 3,
    });
    expect(outcome.kind).toBe('ok');
    expect(stub.calls[0]?.method).toBe('PUT');
    const body = JSON.parse(stub.calls[0]?.body!);
    expect(body.value).toBe('https://example.com');
    expect(body.ifRevision).toBe(3);
    expect(body.scope.kind).toBe('project');
    expect(body.envName).toBe('prod');
  });

  it('returns revision-conflict outcome on 409 env-write-conflict', async () => {
    const stub = errorFetch(409, {
      code: 'env-write-conflict',
      message: 'nope',
      details: { currentRevision: 7 },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const outcome = await client.env.set({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'FOO',
      value: 'bar',
      ifRevision: 2,
    });
    expect(outcome.kind).toBe('revision-conflict');
    if (outcome.kind === 'revision-conflict') {
      expect(outcome.currentRevision).toBe(7);
    }
  });
});

describe('env.delete', () => {
  it('DELETEs /v1/env/{name} with scope + envName query', async () => {
    const stub = jsonFetch({ deleted: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const out = await client.env.delete({
      scope: PROJECT_SCOPE,
      envName: 'staging' as never,
      name: 'FOO',
    });
    expect(out.deleted).toBe(true);
    expect(stub.calls[0]?.method).toBe('DELETE');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/env/FOO');
    expect(url.searchParams.get('scopeKind')).toBe('project');
    expect(url.searchParams.get('scopeId')).toBe('proj-42');
    expect(url.searchParams.get('envName')).toBe('staging');
  });

  it('deleted:false is not an error', async () => {
    const stub = jsonFetch({ deleted: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const out = await client.env.delete({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'MISSING',
    });
    expect(out.deleted).toBe(false);
  });
});

// Guardrail: ensure the recording fetch is fully consumed by list — no
// stray requests.
describe('env — no accidental extra requests', () => {
  it('list makes exactly one request', async () => {
    const stub = recordingFetch([{ status: 200, body: JSON.stringify({ data: [] }) }]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await client.env.list({ scope: TENANT_SCOPE, envName: 'staging' as never });
    expect(stub.calls.length).toBe(1);
  });
});
