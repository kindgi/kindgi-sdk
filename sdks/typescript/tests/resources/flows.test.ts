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

  it("versions.get keeps an unregistered version's unregisteredAt", async () => {
    const stub = jsonFetch({ ...WIRE_GRAPH, unregisteredAt: '2026-09-24T22:00:00.000Z' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const retired = await client.flows.versions.get('ingest.contract-pdf' as never, '1.0.0');
    expect(retired.version).toBe('1.0.0');
    expect(retired.unregisteredAt).toBe('2026-09-24T22:00:00.000Z');
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

describe('flows.pinned', () => {
  const PROJECT_ID = '0b0e9c62-0d6c-4d39-9b1e-6c1a5f6c2d11';
  const ORG_ID = '5f0d1a3c-7c8e-4a51-8d0c-2a9f3b7e4c22';
  const change = {
    id: 'c-1',
    kind: 'flow',
    itemId: 'acme.ticket-triage',
    scope: { kind: 'project', projectId: PROJECT_ID },
    action: 'pin',
    fromVersion: null,
    toVersion: '1.0.0',
    requestedBy: { kind: 'user', id: 'u-1' },
    createdAt: '2026-10-27T05:00:00.000Z',
  };
  const client = (stub: ReturnType<typeof jsonFetch>) =>
    createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });

  it('resolve sends the project and the org', async () => {
    const stub = jsonFetch({ itemId: 'acme.ticket-triage', version: '1.0.0', via: 'latest' });
    const resolved = await client(stub).flows.pinned.resolve('acme.ticket-triage', {
      projectId: PROJECT_ID,
      orgId: ORG_ID,
    });
    expect(resolved.via).toBe('latest');
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/v1/flows/acme.ticket-triage/pinned');
    expect(Object.fromEntries(url.searchParams)).toEqual({ projectId: PROJECT_ID, orgId: ORG_ID });
  });

  it('list GETs /pinned-versions; history pages /pin-history', async () => {
    const listed = jsonFetch({ data: [] });
    await client(listed).flows.pinned.list('acme.ticket-triage');
    expect(listed.calls[0]!.url).toBe(
      'https://api.example.com/v1/flows/acme.ticket-triage/pinned-versions',
    );
    const paged = jsonFetch({ data: [change], hasMore: false });
    await client(paged).flows.pinned.history('acme.ticket-triage', { limit: 5, cursor: 'k' });
    const url = new URL(paged.calls[0]!.url);
    expect(url.pathname).toBe('/v1/flows/acme.ticket-triage/pin-history');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '5', cursor: 'k' });
  });

  it('pin and unpin POST the scope, with an idempotency key', async () => {
    const pinned = jsonFetch(change);
    const made = await client(pinned).flows.pinned.pin(
      'acme.ticket-triage',
      { version: '1.0.0', scope: { kind: 'project', projectId: PROJECT_ID }, reason: 'hold' },
      { idempotencyKey: 'idem-1' },
    );
    expect(made.toVersion).toBe('1.0.0');
    const req = pinned.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/flows/acme.ticket-triage/pinned/pin');
    expect(req.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      version: '1.0.0',
      scope: { kind: 'project', projectId: PROJECT_ID },
      reason: 'hold',
    });
    const unpinned = jsonFetch({
      ...change,
      action: 'unpin',
      fromVersion: '1.0.0',
      toVersion: null,
    });
    await client(unpinned).flows.pinned.unpin('acme.ticket-triage', { scope: { kind: 'tenant' } });
    const unpin = unpinned.calls[0]!;
    expect(unpin.url).toBe('https://api.example.com/v1/flows/acme.ticket-triage/pinned/unpin');
    expect(unpin.headers['idempotency-key']).toBeUndefined();
    expect(JSON.parse(unpin.body ?? '{}')).toEqual({ scope: { kind: 'tenant' } });
  });
});
