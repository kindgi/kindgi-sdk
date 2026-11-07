// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const TENANT = '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b';
const ATTACH = '0b5e8f2a-7c1d-4e3f-9a2b-1c0d9e8f7a6b';
const ON_ATTACH = `${API}/v1/system/tenants/${TENANT}/projects/p%2F1/attaches/${ATTACH}`;

const SPEC = {
  userId: 'user-dana',
  tokenId: 'tok-dana',
  routeUrl: 'https://attach.example.com/s/1',
  routeToken: 'route-secret',
};
const ATTACHED = {
  attachId: ATTACH,
  projectId: 'p/1',
  userId: 'user-dana',
  tokenId: 'tok-dana',
  routeUrl: 'https://attach.example.com/s/1',
  createdAt: '2026-11-07T09:00:00.000Z',
};

describe('systemAttaches — wire round-trip', () => {
  it('put: PUT …/attaches/{attachId} with the spec and the idempotency key', async () => {
    const stub = jsonFetch(ATTACHED);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemAttaches.put(TENANT, 'p/1', ATTACH, SPEC, { idempotencyKey: 'a-1' }),
    ).toEqual(ATTACHED);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`PUT ${ON_ATTACH}`);
    expect(JSON.parse(call.body ?? '{}')).toEqual(SPEC);
    expect(call.headers['idempotency-key']).toBe('a-1');
  });

  it('putIndex: PUT …/attaches/{attachId}/index with the index as the body', async () => {
    const revision = {
      attachId: ATTACH,
      revision: 3,
      hash: 'a'.repeat(64),
      createdAt: '2026-11-07T09:01:00.000Z',
    };
    const index = { v: 1, packId: 'acme.aperture', artifactVersion: '20261107.1', tools: [] };
    const stub = jsonFetch(revision);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemAttaches.putIndex(TENANT, 'p/1', ATTACH, index)).toEqual(revision);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`PUT ${ON_ATTACH}/index`);
    expect(JSON.parse(call.body ?? '{}')).toEqual(index);
    expect(call.headers['idempotency-key']).toBeUndefined();
  });

  it('putIndex: the idempotency key, when given, is sent', async () => {
    const stub = jsonFetch({
      attachId: ATTACH,
      revision: 1,
      hash: 'b'.repeat(64),
      createdAt: '2026-11-07T09:01:00.000Z',
    });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.systemAttaches.putIndex(
      TENANT,
      'p/1',
      ATTACH,
      { v: 1 },
      { idempotencyKey: 'i-1' },
    );
    expect(stub.calls[0]!.headers['idempotency-key']).toBe('i-1');
  });

  it('end: DELETE …/attaches/{attachId} with the idempotency key, answered with the ended attach', async () => {
    const ended = { ...ATTACHED, endedAt: '2026-11-07T09:02:00.000Z', endedReason: 'ended' };
    const stub = jsonFetch(ended);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemAttaches.end(TENANT, 'p/1', ATTACH, { idempotencyKey: 'e-1' }),
    ).toEqual(ended);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`DELETE ${ON_ATTACH}`);
    expect(call.body).toBeUndefined();
    expect(call.headers['idempotency-key']).toBe('e-1');
  });

  it("a refusal is the server's code: a 409 is a conflict, its code the reason", async () => {
    const stub = errorFetch(409, {
      code: 'attach-ended',
      message: 'Attach ended (production-on): write a new one.',
      details: { endedReason: 'production-on' },
    });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(client.systemAttaches.put(TENANT, 'p/1', ATTACH, SPEC)).rejects.toMatchObject({
      error: { code: 'conflict', reason: 'attach-ended', serverCode: 'attach-ended' },
    });
  });
});
