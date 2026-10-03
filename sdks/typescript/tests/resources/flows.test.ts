// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_GRAPH = {
  id: 'ingest.contract-pdf',
  version: '1.0.0',
  nodes: [{ id: 'extract', kind: 'tool', ref: 'inline' }],
  edges: [{ id: 'e0', from: '$start', to: 'extract' }],
};

describe('flows.define', () => {
  it('POSTs /v1/flows with body + Idempotency-Key and returns { flowId, version }', async () => {
    const stub = jsonFetch({ flowId: 'ingest.contract-pdf', version: '1.0.0' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.flows.define(WIRE_GRAPH as never, {
      projectId: 'proj-1',
      idempotencyKey: 'idem-g',
    });

    expect(result.flowId).toBe('ingest.contract-pdf');
    expect(result.version).toBe('1.0.0');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/flows');
    expect(req.headers['idempotency-key']).toBe('idem-g');
  });

  it('maps 400 validation-failed to InvalidRequestError with issues', async () => {
    const stub = errorFetch(400, {
      code: 'validation-failed',
      message: 'nope',
      details: {
        issues: [{ path: '/nodes/0/kind', message: 'unknown kind' }],
      },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.flows.define(WIRE_GRAPH as never, { projectId: 'proj-1' }),
    ).rejects.toMatchObject({
      error: { code: 'invalid-request' },
    });
  });
});

describe('flows.get / flows.list', () => {
  it('GETs /v1/flows/{flowId}', async () => {
    const stub = jsonFetch(WIRE_GRAPH);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const g = await client.flows.get('ingest.contract-pdf' as never);
    expect(g.id).toBe('ingest.contract-pdf');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/flows/ingest.contract-pdf');
  });

  it('GETs /v1/flows with name filter', async () => {
    const stub = jsonFetch({ data: [WIRE_GRAPH], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.flows.list({ name: 'ingest.' });
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('name')).toBe('ingest.');
  });
});

describe('flows.versions / flows.getVersion', () => {
  it('GETs /v1/flows/{flowId}/versions', async () => {
    const stub = jsonFetch({ data: [WIRE_GRAPH], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.flows.versions('ingest.contract-pdf' as never);
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/flows/ingest.contract-pdf/versions',
    );
  });

  it('GETs /v1/flows/{flowId}/versions/{version}', async () => {
    const stub = jsonFetch(WIRE_GRAPH);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.flows.getVersion('ingest.contract-pdf' as never, '1.0.0');
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/flows/ingest.contract-pdf/versions/1.0.0',
    );
  });
});

describe('flows.delete', () => {
  it('POSTs /v1/flows/{flowId}/versions/{version}/unregister', async () => {
    const stub = jsonFetch({
      flowId: 'ingest.contract-pdf',
      version: '1.0.0',
      unregistered: true,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.flows.delete('ingest.contract-pdf' as never, '1.0.0', {
      idempotencyKey: 'idem-x',
    });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://api.example.com/v1/flows/ingest.contract-pdf/versions/1.0.0/unregister',
    );
    expect(req.headers['idempotency-key']).toBe('idem-x');
  });
});

describe('flows.validate (not yet wired)', () => {
  it('throws not-yet-wired without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.flows.validate(WIRE_GRAPH as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'flows.validate' },
    });
    expect(stub.calls.length).toBe(0);
  });
});

describe('flows.define — projectId (POST /v1/flows requires it)', () => {
  it('sends options.projectId in the body next to the flow', async () => {
    const stub = jsonFetch({ flowId: 'ingest.contract-pdf', version: '1.0.0' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.flows.define(WIRE_GRAPH as never, { projectId: 'proj-1' });

    const req = stub.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/flows');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...WIRE_GRAPH, projectId: 'proj-1' });
  });
});
