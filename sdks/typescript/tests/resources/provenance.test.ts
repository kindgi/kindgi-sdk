// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_RECORD = {
  id: 'prov-1',
  runId: 'run-abc',
  tenantId: 't-1',
  version: '1.0.0',
  createdAt: '2026-09-19T00:00:00.000Z',
  dag: { nodes: [], edges: [] },
};

describe('provenance.get', () => {
  it('GETs /v1/provenance/{runId} and returns full record', async () => {
    const stub = jsonFetch(WIRE_RECORD);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const rec = await client.provenance.get('run-abc' as never);
    expect(rec.dag.nodes).toEqual([]);
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/provenance/run-abc');
    expect(stub.calls[0]?.method).toBe('GET');
  });

  it('maps 404 provenance-not-found to NotFoundError', async () => {
    const stub = errorFetch(404, {
      code: 'provenance-not-found',
      message: 'nope',
      details: { runId: 'run-abc' },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.provenance.get('run-abc' as never)).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'provenance', id: 'run-abc' } },
    });
  });

  it("keeps the server's details as fields: why the run has no record yet", async () => {
    const details = { runId: 'run-abc', recordState: 'failed', reason: 'build-failed' };
    const stub = errorFetch(404, { code: 'provenance-not-found', message: 'nope', details });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.provenance.get('run-abc' as never)).rejects.toMatchObject({
      error: { code: 'not-found', fields: details },
    });
  });

  it('has no fields when the server sent no details', async () => {
    const stub = errorFetch(404, { code: 'provenance-not-found', message: 'nope' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const thrown: unknown = await client.provenance
      .get('run-abc' as never)
      .catch((e: unknown) => e);
    expect(thrown).toMatchObject({ error: { code: 'not-found', resource: { id: 'unknown' } } });
    expect((thrown as { error: object }).error).not.toHaveProperty('fields');
  });
});

describe('provenance.query', () => {
  it('GETs /v1/provenance and returns Page<metadata>', async () => {
    const stub = jsonFetch({
      data: [
        {
          id: 'prov-1',
          runId: 'run-1',
          tenantId: 't-1',
          version: '1.0.0',
          createdAt: '2026-09-19T00:00:00.000Z',
          signed: false,
        },
      ],
      hasMore: false,
      flowId: 'acme.report',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.provenance.query({
      runId: 'run-1' as never,
      flowId: 'acme.report' as never,
      createdAfter: '2026-01-01T00:00:00Z' as never,
    });
    expect(page.items[0]?.signed).toBe(false);
    expect(page.flowId).toBe('acme.report');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('runId')).toBe('run-1');
    expect(url.searchParams.get('flowId')).toBe('acme.report');
    expect(url.searchParams.get('createdAfter')).toBe('2026-01-01T00:00:00Z');
  });

  it("a page with no flowId, as a runtime that doesn't list records by flow sends it", async () => {
    const stub = jsonFetch({
      data: [
        {
          id: 'prov-1',
          runId: 'run-1',
          tenantId: 't-1',
          version: '1.0.0',
          createdAt: '2026-09-19T00:00:00.000Z',
          signed: false,
        },
      ],
      hasMore: false,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.provenance.query({ flowId: 'acme.report' as never });
    expect(page.items).toHaveLength(1);
    expect(page).not.toHaveProperty('flowId');
  });
});

describe('provenance.export', () => {
  it('POSTs /v1/provenance/{runId}/export with signingKeyId body', async () => {
    const stub = jsonFetch({
      runId: 'run-abc',
      bundle: 'YmFzZTY0',
      bundleSchemaVersion: '1.0.0',
      algorithm: 'ed25519',
      signingKeyId: 'key-1',
      signature: 'c2ln',
      publicKey: '-----BEGIN PUBLIC KEY-----\nxxx\n-----END PUBLIC KEY-----\n',
      canonicalization: 'sorted-key-json',
      exportedAt: '2026-09-19T00:00:00.000Z',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const bundle = await client.provenance.export({
      runId: 'run-abc' as never,
      signingKeyId: 'key-1',
      includeMessages: true,
      idempotencyKey: 'idem-1',
    });

    expect(bundle.bundle).toBe('YmFzZTY0');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/provenance/run-abc/export');
    expect(req.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      signingKeyId: 'key-1',
      includeMessages: true,
    });
  });
});

describe('provenance.verify', () => {
  it('checks the export where it is read, without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const bogusBundle = {
      runId: 'r' as never,
      bundle: '',
      bundleSchemaVersion: '1.2.0',
      algorithm: 'ed25519' as const,
      signingKeyId: 'k',
      signature: '',
      publicKey: 'pk',
      canonicalization: 'sorted-key-json' as const,
      exportedAt: '2026-09-19T00:00:00.000Z' as never,
    };
    const checked = await client.provenance.verify(bogusBundle, 'pk');
    expect(checked.valid).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });
});
