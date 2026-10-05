// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const JUDGMENT = {
  id: 'j-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  runId: 'run-1',
  subject: { kind: 'agent', id: 'acme.matcher', version: '2.0.0' },
  item: { key: 'c1', pointer: '/matches/0' },
  verdict: 'yes',
  assertedBy: { kind: 'user', id: 'user-1' },
  createdAt: '2026-10-01T00:00:00.000Z',
};

function clientFor(stub: { fetch: typeof fetch }) {
  return createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });
}

describe('judgments.create', () => {
  it('POSTs /v1/judgments with the body and Idempotency-Key', async () => {
    const stub = jsonFetch(JUDGMENT, { status: 201 });
    const result = await clientFor(stub).judgments.create(
      {
        runId: 'run-1',
        item: { key: 'c1', pointer: '/matches/0' },
        verdict: 'yes',
        reason: 'Right company.',
        judgeClassId: 'jc-1',
        participantId: 'end-user-1',
      },
      { idempotencyKey: 'idem-j' },
    );
    expect(result.id).toBe('j-1');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/judgments');
    expect(req.headers['idempotency-key']).toBe('idem-j');
    expect(JSON.parse(req.body!)).toEqual({
      runId: 'run-1',
      item: { key: 'c1', pointer: '/matches/0' },
      verdict: 'yes',
      reason: 'Right company.',
      judgeClassId: 'jc-1',
      participantId: 'end-user-1',
    });
  });

  it('works without a judge class', async () => {
    const stub = jsonFetch(JUDGMENT, { status: 201 });
    await clientFor(stub).judgments.create({ runId: 'run-1', item: { key: 'c1' }, verdict: 'no' });
    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      runId: 'run-1',
      item: { key: 'c1' },
      verdict: 'no',
    });
  });

  it('surfaces run-not-finished', async () => {
    const stub = errorFetch(409, { code: 'run-not-finished', message: 'Run has no output yet.' });
    await expect(
      clientFor(stub).judgments.create({ runId: 'run-1', item: { key: 'c1' }, verdict: 'yes' }),
    ).rejects.toMatchObject({ error: { code: 'server', serverCode: 'run-not-finished' } });
  });
});

describe('judgments.list', () => {
  it('GETs /v1/judgments with every filter', async () => {
    const stub = jsonFetch({ data: [JUDGMENT], hasMore: true, nextCursor: 'c2' });
    const page = await clientFor(stub).judgments.list({
      limit: 10,
      runId: 'run-1',
      agentId: 'acme.matcher',
      agentVersion: '2.0.0',
      flowId: 'acme.flow',
      verdict: 'yes',
      judgeClassId: 'jc-1',
      participantId: 'end-user-1',
      scope: { kind: 'project', projectId: 'proj-1' },
    });
    expect(page.items[0]?.id).toBe('j-1');
    expect(page.nextCursor).toBe('c2');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/judgments');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '10',
      runId: 'run-1',
      agentId: 'acme.matcher',
      agentVersion: '2.0.0',
      flowId: 'acme.flow',
      verdict: 'yes',
      judgeClassId: 'jc-1',
      participantId: 'end-user-1',
      scopeKind: 'project',
      scopeId: 'proj-1',
    });
  });
});

describe('judgments.get', () => {
  it('GETs /v1/judgments/{id} with the copies', async () => {
    const stub = jsonFetch({
      ...JUDGMENT,
      run: {
        runId: 'run-1',
        subject: JUDGMENT.subject,
        input: {},
        output: { matches: [] },
        capturedAt: '2026-10-01T00:00:00.000Z',
      },
      itemValue: { id: 'c1' },
    });
    const got = await clientFor(stub).judgments.get('j/1');
    expect(got.itemValue).toEqual({ id: 'c1' });
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/judgments/j%2F1');
  });
});

describe('judgments.unregister', () => {
  it('POSTs /v1/judgments/{id}/unregister and returns nothing', async () => {
    const stub = jsonFetch({ judgmentId: 'j-1', unregistered: true });
    const result = await clientFor(stub).judgments.unregister('j-1', { idempotencyKey: 'k' });
    expect(result).toBeUndefined();
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/judgments/j-1/unregister');
    expect(req.headers['idempotency-key']).toBe('k');
  });
});
