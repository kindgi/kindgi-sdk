// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { KindgiApiError, createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 'secret-token' };
const SPEC = {
  id: 'acme.drafter',
  version: '1.0.0',
  name: 'Drafter',
  instructions: 'Draft a citation.',
  capabilities: [],
  tools: [],
  retrieval: [],
  guardrails: [],
} as unknown as Parameters<ReturnType<typeof createClient>['agents']['define']>[0];
const PROJECT = { projectId: 'proj-1' };

describe('agents.define', () => {
  it('POSTs /v1/agents with Bearer + JSON body and returns agentId', async () => {
    const stub = jsonFetch({ agentId: 'ag-42', version: '1.0.0' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com/',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const id = await client.agents.define(SPEC, PROJECT);

    expect(id).toBe('ag-42');
    expect(stub.calls.length).toBe(1);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/agents');
    expect(req.headers.authorization).toBe('Bearer secret-token');
    expect(req.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(req.headers['idempotency-key']).toBeUndefined();
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...SPEC, ...PROJECT });
  });

  it('forwards Idempotency-Key when the caller supplies one', async () => {
    const stub = jsonFetch({ agentId: 'ag-9', version: '1.0.0' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.agents.define(SPEC, { ...PROJECT, idempotencyKey: 'idem-abc' });

    expect(stub.calls[0]?.headers['idempotency-key']).toBe('idem-abc');
  });

  it('throws KindgiApiError with mapped code on 409', async () => {
    const stub = errorFetch(409, {
      code: 'agent-already-registered',
      message: 'Already registered',
      details: { agentId: 'ag-42', version: '1.0.0' },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.agents.define(SPEC, PROJECT)).rejects.toMatchObject({
      name: 'KindgiApiError',
      error: { code: 'conflict', reason: 'agent-already-registered' },
    });
  });

  it('surfaces 401 auth-missing as AuthError variant', async () => {
    const stub = errorFetch(401, { code: 'auth-missing', message: 'no token' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    try {
      await client.agents.define(SPEC, PROJECT);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KindgiApiError);
      expect((e as KindgiApiError).error).toMatchObject({
        code: 'auth',
        reason: 'unauthenticated',
      });
    }
  });
});

describe('agents.define — projectId (POST /v1/agents requires it)', () => {
  it('sends options.projectId in the body next to the spec', async () => {
    const stub = jsonFetch({ agentId: 'ag-42', version: '1.0.0' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.agents.define(SPEC, { projectId: 'proj-1', idempotencyKey: 'idem-p' });

    const req = stub.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/agents');
    expect(req.headers['idempotency-key']).toBe('idem-p');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...SPEC, projectId: 'proj-1' });
  });
});

describe('agents.versions.derive', () => {
  it('POSTs /v1/agents/{agentId}/versions with the source version and the pin swaps', async () => {
    const derived = {
      ...SPEC,
      version: '1.0.1',
      derivedFrom: { version: '1.0.0', reason: 'edited' },
    };
    const stub = jsonFetch(derived, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const agent = await client.agents.versions.derive(
      'acme.drafter' as never,
      {
        from: '1.0.0',
        pins: { prompts: { 'acme.drafter-prompt': '1.1.0' } },
        label: 'tighter tone',
      },
      { idempotencyKey: 'idem-d' },
    );

    expect(agent.version).toBe('1.0.1');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/agents/acme.drafter/versions');
    expect(req.headers['idempotency-key']).toBe('idem-d');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      from: '1.0.0',
      pins: { prompts: { 'acme.drafter-prompt': '1.1.0' } },
      label: 'tighter tone',
    });
  });
});

describe('agents.live and agents.promotions', () => {
  const PROJECT_ID = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
  const promotion = {
    id: 'p-1',
    agentId: 'acme.drafter',
    scope: { kind: 'project', projectId: PROJECT_ID },
    action: 'promote',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    requestedBy: { kind: 'user', id: 'u-1' },
    createdAt: '2026-10-05T12:00:00.000Z',
  };
  const client = (stub: ReturnType<typeof jsonFetch>) =>
    createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });

  it('live.resolve sends the project and the segment path in order', async () => {
    const stub = jsonFetch({ agentId: 'acme.drafter', version: '1.1.0', via: 'latest' });
    await client(stub).agents.live.resolve('acme.drafter', {
      projectId: PROJECT_ID,
      segments: [
        { key: 'company', value: 'acme' },
        { key: 'role', value: 'counsel' },
      ],
    });
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/v1/agents/acme.drafter/live');
    expect(url.searchParams.get('projectId')).toBe(PROJECT_ID);
    expect(url.searchParams.getAll('segment')).toEqual(['company:acme', 'role:counsel']);
  });

  it('live.list GETs /live-versions', async () => {
    const stub = jsonFetch({ data: [] });
    await client(stub).agents.live.list('acme.drafter');
    expect(stub.calls[0]!.url).toBe('https://api.example.com/v1/agents/acme.drafter/live-versions');
  });

  it('promotions.create POSTs the version and scope, with an idempotency key', async () => {
    const stub = jsonFetch(promotion, { status: 201 });
    const made = await client(stub).agents.promotions.create(
      'acme.drafter',
      { version: '1.1.0', scope: { kind: 'project', projectId: PROJECT_ID }, reason: 'evals' },
      { idempotencyKey: 'idem-1' },
    );
    expect(made.toVersion).toBe('1.1.0');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/agents/acme.drafter/promotions');
    expect(req.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      version: '1.1.0',
      scope: { kind: 'project', projectId: PROJECT_ID },
      reason: 'evals',
    });
  });

  it('promotions.list turns a segment scope into the query filter', async () => {
    const stub = jsonFetch({ data: [promotion], hasMore: false });
    await client(stub).agents.promotions.list('acme.drafter', {
      scope: { kind: 'segment', projectId: PROJECT_ID, path: [{ key: 'company', value: 'acme' }] },
      limit: 5,
    });
    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe('/v1/agents/acme.drafter/promotions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scopeKind: 'segment',
      scopeId: PROJECT_ID,
      segment: 'company:acme',
      limit: '5',
    });
  });

  it('promotions.get GETs one promotion', async () => {
    const stub = jsonFetch(promotion);
    await client(stub).agents.promotions.get('acme.drafter', 'p-1');
    expect(stub.calls[0]!.url).toBe(
      'https://api.example.com/v1/agents/acme.drafter/promotions/p-1',
    );
  });

  it('live.rollback and live.unpin POST the scope', async () => {
    const body = JSON.stringify({ ...promotion, action: 'rollback' });
    const stub = recordingFetch([
      { status: 200, body },
      { status: 200, body },
    ]);
    const c = client(stub);
    await c.agents.live.rollback('acme.drafter', { scope: { kind: 'tenant' }, toVersion: '1.0.0' });
    await c.agents.live.unpin('acme.drafter', { scope: { kind: 'tenant' }, reason: 'done' });
    expect(
      stub.calls.map((r) => [r.method, new URL(r.url).pathname, JSON.parse(r.body ?? '{}')]),
    ).toEqual([
      [
        'POST',
        '/v1/agents/acme.drafter/live/rollback',
        { scope: { kind: 'tenant' }, toVersion: '1.0.0' },
      ],
      ['POST', '/v1/agents/acme.drafter/live/unpin', { scope: { kind: 'tenant' }, reason: 'done' }],
    ]);
  });

  it('a version that is not registered surfaces as KindgiApiError', async () => {
    const stub = errorFetch(404, { code: 'agent-version-not-found', message: 'no 9.9.9' });
    await expect(
      client(stub).agents.promotions.create('acme.drafter', {
        version: '9.9.9',
        scope: { kind: 'tenant' },
      }),
    ).rejects.toBeInstanceOf(KindgiApiError);
  });
});
