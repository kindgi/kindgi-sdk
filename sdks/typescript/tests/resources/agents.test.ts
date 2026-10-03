// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { KindgiApiError, createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

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
