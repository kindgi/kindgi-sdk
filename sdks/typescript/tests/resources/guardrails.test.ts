// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_GUARDRAIL = {
  id: 'acme.must-cite-3',
  name: 'Must cite 3+ authorities',
  kind: 'zero-llm' as const,
  check: 'must-cite',
  config: { minCitations: 3 },
  action: { 'on-violation': 'halt' as const },
  severity: 'error' as const,
};

describe('guardrails.author', () => {
  it('POSTs /v1/guardrails with body + idempotency key', async () => {
    const stub = jsonFetch({ guardrailId: 'acme.must-cite-3' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.guardrails.author(
      {
        id: 'acme.must-cite-3',
        name: 'Must cite 3+ authorities',
        kind: 'zero-llm',
        check: 'must-cite',
        config: { minCitations: 3 },
        action: { 'on-violation': 'halt' },
        severity: 'error',
      },
      { projectId: 'proj-1', idempotencyKey: 'idem-inv' },
    );

    expect(result.guardrailId).toBe('acme.must-cite-3');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/guardrails');
    expect(req.headers['idempotency-key']).toBe('idem-inv');
    expect(JSON.parse(req.body ?? '{}').action).toEqual({ 'on-violation': 'halt' });
  });

  it('maps 409 already-registered onto conflict', async () => {
    const stub = errorFetch(409, {
      code: 'guardrail-already-registered',
      message: 'already registered',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.guardrails.author(
        {
          id: 'x',
          kind: 'zero-llm',
          action: { 'on-violation': 'halt' },
        },
        { projectId: 'proj-1' },
      ),
    ).rejects.toMatchObject({ error: { code: 'conflict' } });
  });
});

describe('guardrails.get / list / delete', () => {
  it('GETs /v1/guardrails/{id}', async () => {
    const stub = jsonFetch(WIRE_GUARDRAIL);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const inv = await client.guardrails.get('acme.must-cite-3' as never);
    expect(inv.kind).toBe('zero-llm');
    expect(inv.action['on-violation']).toBe('halt');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/guardrails/acme.must-cite-3');
  });

  it('GETs /v1/guardrails with name filter', async () => {
    const stub = jsonFetch({ data: [WIRE_GUARDRAIL], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.guardrails.list({ name: 'acme', limit: 25 });
    expect(page.items).toHaveLength(1);
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('name')).toBe('acme');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('POSTs /v1/guardrails/{id}/unregister on delete', async () => {
    const stub = jsonFetch({ guardrailId: 'acme.must-cite-3', unregistered: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.guardrails.delete('acme.must-cite-3' as never, {
      idempotencyKey: 'idem-del',
    });
    expect(result.unregistered).toBe(true);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/guardrails/acme.must-cite-3/unregister');
    expect(req.headers['idempotency-key']).toBe('idem-del');
  });

  it('maps 404 guardrail-not-found on get', async () => {
    const stub = errorFetch(404, { code: 'guardrail-not-found', message: 'nope' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.guardrails.get('unknown' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('guardrails not-yet-wired surface', () => {
  it('versions / builtIns / evaluate throw not-yet-wired without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.guardrails.versions('x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'guardrails.versions' },
    });
    await expect(client.guardrails.builtIns()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'guardrails.builtIns' },
    });
    await expect(client.guardrails.evaluate('x' as never, {})).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'guardrails.evaluate' },
    });
    expect(stub.calls.length).toBe(0);
  });
});

describe('guardrails.author — projectId (POST /v1/guardrails requires it)', () => {
  it('sends options.projectId in the body next to the spec', async () => {
    const stub = jsonFetch({ guardrailId: 'acme.must-cite-3' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const spec = {
      id: 'acme.must-cite-3',
      kind: 'zero-llm' as const,
      check: 'must-cite',
      action: { 'on-violation': 'halt' as const },
    };

    await client.guardrails.author(spec, { projectId: 'proj-1' });

    const req = stub.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/guardrails');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...spec, projectId: 'proj-1' });
  });
});
