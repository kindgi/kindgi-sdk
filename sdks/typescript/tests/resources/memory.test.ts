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

  it('POSTs /v1/memory/facts/{factId}/supersede on delete', async () => {
    const stub = jsonFetch({ factId: 'fact-1', superseded: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.memory.facts.delete('fact-1' as never, {
      idempotencyKey: 'idem-del',
    });
    expect(result.superseded).toBe(true);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/memory/facts/fact-1/supersede');
    expect(req.headers['idempotency-key']).toBe('idem-del');
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
