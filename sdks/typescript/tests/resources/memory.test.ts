// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const TENANT = '00000000-0000-4000-8000-000000000002';

const WIRE_FACT = {
  id: 'fact-1',
  type: 'contract-clause',
  scope: { tenantId: TENANT, projectId: 'proj-1' },
  version: 1,
  createdAt: '2026-09-20T00:00:00.000Z',
  content: { clause: 'Liquidated damages exceeding 5% of contract value.' },
  contentHash: 'sha256-abc',
};

describe('memory.facts.write / read / list / delete', () => {
  it('POSTs /v1/memory/facts with body + idempotency key + returns Fact', async () => {
    const stub = jsonFetch(WIRE_FACT, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const fact = await client.memory.facts.write(
      {
        type: 'contract-clause',
        scope: { tenantId: TENANT, projectId: 'proj-1' },
        content: { clause: 'Liquidated damages exceeding 5% of contract value.' },
      },
      { idempotencyKey: 'idem-write' },
    );
    expect(fact.id).toBe('fact-1');
    expect(fact.version).toBe(1);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/memory/facts');
    expect(req.headers['idempotency-key']).toBe('idem-write');
    expect(JSON.parse(req.body ?? '{}').type).toBe('contract-clause');
  });

  it('GETs /v1/memory/facts/{factId}', async () => {
    const stub = jsonFetch(WIRE_FACT);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const fact = await client.memory.facts.read('fact-1' as never);
    expect(fact.type).toBe('contract-clause');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/memory/facts/fact-1');
  });

  it('GETs /v1/memory/facts with type + scope filters (scope JSON-encoded)', async () => {
    const stub = jsonFetch({ data: [WIRE_FACT], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.memory.facts.list({
      type: 'contract-clause',
      scope: { tenantId: TENANT, projectId: 'proj-1' },
      limit: 50,
    });
    expect(page.items).toHaveLength(1);
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('type')).toBe('contract-clause');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(JSON.parse(url.searchParams.get('scope')!).projectId).toBe('proj-1');
  });

  it('reads one revision (`version`) or memory as it stood (`asOf`)', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(WIRE_FACT) },
      { status: 200, body: JSON.stringify({ data: [WIRE_FACT], hasMore: false }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.memory.facts.read('fact-1' as never, { version: 2 });
    await client.memory.facts.list({ asOf: '2026-09-21T00:00:00.000Z' });
    expect(new URL(stub.calls[0]?.url).searchParams.get('version')).toBe('2');
    expect(new URL(stub.calls[1]?.url).searchParams.get('asOf')).toBe('2026-09-21T00:00:00.000Z');
  });

  it('POSTs /v1/memory/facts/{factId}/supersede with the next revision', async () => {
    const stub = jsonFetch({ ...WIRE_FACT, version: 2, revisionId: 'rev-2', supersedes: 'fact-1' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const next = await client.memory.facts.supersede(
      'fact-1' as never,
      { content: { clause: 'Capped at 3%.' }, expectVersion: 1 },
      { idempotencyKey: 'idem-sup' },
    );
    expect(next.id).toBe('fact-1');
    expect(next.version).toBe(2);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/memory/facts/fact-1/supersede');
    expect(req.headers['idempotency-key']).toBe('idem-sup');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      content: { clause: 'Capped at 3%.' },
      expectVersion: 1,
    });
  });

  it('DELETEs /v1/memory/facts/{factId} and returns the closed revision', async () => {
    const stub = jsonFetch({
      ...WIRE_FACT,
      invalidatedAt: '2026-09-21T00:00:00.000Z',
      invalidationReason: 'deleted',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const closed = await client.memory.facts.delete('fact-1' as never, { expectVersion: 1 });
    expect(closed.invalidationReason).toBe('deleted');
    const req = stub.calls[0]!;
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('https://api.example.com/v1/memory/facts/fact-1?expectVersion=1');
  });

  it('POSTs /v1/memory/facts/{factId}/verify', async () => {
    const stub = jsonFetch({ ...WIRE_FACT, version: 2, trust: 'verified', verifiedBy: 'user:u1' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const verified = await client.memory.facts.verify('fact-1' as never);
    expect(verified.trust).toBe('verified');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/memory/facts/fact-1/verify');
    expect(JSON.parse(req.body ?? '{}')).toEqual({});
  });

  it('GETs /v1/memory/facts/{factId}/revisions and unwraps the list', async () => {
    const stub = jsonFetch({ data: [{ ...WIRE_FACT, version: 2 }, WIRE_FACT] });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const revisions = await client.memory.facts.revisions('fact-1' as never);
    expect(revisions.map((r) => r.version)).toEqual([2, 1]);
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/memory/facts/fact-1/revisions');
  });

  it('maps 409 fact-changed to a conflict', async () => {
    const stub = errorFetch(409, { code: 'fact-changed', message: 'changed' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.memory.facts.supersede('fact-1' as never, { content: 'x', expectVersion: 1 }),
    ).rejects.toMatchObject({ error: { code: 'conflict', reason: 'fact-changed' } });
  });

  it('maps 404 fact-not-found on read', async () => {
    const stub = errorFetch(404, { code: 'fact-not-found', message: 'nope' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.memory.facts.read('nope' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('memory.search — /v1/memory/retrieve', () => {
  it('POSTs the retrieve intent and unwraps `{ results: [...] }` to a bounded array', async () => {
    const stub = jsonFetch({
      results: [{ fact: WIRE_FACT, score: 0.87 }],
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const hits = await client.memory.search({
      mode: 'semantic',
      query: 'liquidated damages exceeding 5%',
      type: 'contract-clause',
      scope: { tenantId: TENANT },
      limit: 20,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.score).toBe(0.87);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/memory/retrieve');
    const body = JSON.parse(req.body ?? '{}');
    expect(body.mode).toBe('semantic');
    expect(body.query).toBe('liquidated damages exceeding 5%');
  });
});

describe('memory.logs not-yet-wired surface', () => {
  it('append / list / verify all throw not-yet-wired without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.memory.logs.append({ kind: 'step', payload: {} })).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'memory.logs.append' },
    });
    await expect(client.memory.logs.list()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'memory.logs.list' },
    });
    await expect(client.memory.logs.verify([])).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'memory.logs.verify' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
