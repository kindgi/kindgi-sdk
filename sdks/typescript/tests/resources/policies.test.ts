// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_POLICY = {
  id: 'access.default',
  tenantId: '00000000-0000-4000-8000-000000000002',
  version: '1.0.0',
  kind: 'access-control' as const,
  spec: { rules: [] },
};

describe('policies.author', () => {
  it('POSTs /v1/policies and returns { policyId, version }', async () => {
    const stub = jsonFetch({ policyId: 'access.default', version: '1.0.0' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.policies.author(
      {
        id: 'access.default',
        version: '1.0.0',
        kind: 'access-control',
        spec: { rules: [] },
      },
      { idempotencyKey: 'idem-p' },
    );

    expect(result.policyId).toBe('access.default');
    expect(result.version).toBe('1.0.0');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/policies');
    expect(req.headers['idempotency-key']).toBe('idem-p');
  });
});

describe('policies.get / list / versions', () => {
  it('GETs /v1/policies/{policyId}', async () => {
    const stub = jsonFetch(WIRE_POLICY);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const p = await client.policies.get('access.default' as never);
    expect(p.kind).toBe('access-control');
  });

  it('GETs /v1/policies with kind filter', async () => {
    const stub = jsonFetch({ data: [WIRE_POLICY], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.policies.list({ kind: 'access-control' });
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('kind')).toBe('access-control');
  });

  it('GETs /v1/policies/{policyId}/versions', async () => {
    const stub = jsonFetch({ data: [WIRE_POLICY], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.policies.versions('access.default' as never);
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/policies/access.default/versions');
  });

  it('GETs /v1/policies/{policyId}/versions/{version}', async () => {
    const stub = jsonFetch(WIRE_POLICY);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.policies.getVersion('access.default' as never, '1.0.0');
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/policies/access.default/versions/1.0.0',
    );
  });

  it('maps 404 not-found on getVersion', async () => {
    const stub = errorFetch(404, { code: 'not-found', message: 'no such policy version' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.policies.getVersion('access.default' as never, '9.9.9'),
    ).rejects.toMatchObject({ error: { code: 'not-found' } });
  });
});

describe('policies.unregister', () => {
  it('POSTs /v1/policies/{policyId}/versions/{version}/unregister', async () => {
    const stub = jsonFetch({
      policyId: 'access.default',
      version: '1.0.0',
      unregistered: true,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.policies.unregister('access.default' as never, '1.0.0', {
      idempotencyKey: 'idem-u',
    });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://api.example.com/v1/policies/access.default/versions/1.0.0/unregister',
    );
    expect(req.headers['idempotency-key']).toBe('idem-u');
  });
});

describe('policies not-yet-wired surface', () => {
  it('activate / evaluate throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.policies.activate('p' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'policies.activate' },
    });
    await expect(
      client.policies.evaluate('p' as never, {
        principal: {},
        resource: { kind: 'x', id: 'y' },
        action: 'read',
      }),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'policies.evaluate' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
