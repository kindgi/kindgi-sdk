// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const CORRECTION = {
  id: 'j-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  runId: 'run-1',
  subject: { kind: 'agent', id: 'acme.matcher', version: '2.0.0' },
  answer: 'wrong',
  why: 'The match is the wrong company.',
  status: 'open',
  sortedTo: 'improve',
  sorted: { by: { kind: 'rule' }, at: '2026-10-01T00:00:00.000Z' },
  madeBy: { kind: 'user', id: 'user-1' },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function clientFor(stub: { fetch: typeof fetch }) {
  return createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch });
}

describe('corrections.create', () => {
  it('POSTs /v1/corrections with the body and Idempotency-Key', async () => {
    const stub = jsonFetch(CORRECTION, { status: 201 });
    const result = await clientFor(stub).corrections.create(
      {
        runId: 'run-1',
        decisions: 'wrong',
        shouldCall: [{ tool: 'acme.lookup', args: { name: 'Acme' } }, { tool: 'acme.rank' }],
        mustNotCall: ['acme.refund'],
        answer: 'wrong',
        why: 'Wrong company.',
        items: [{ key: 'c1', pointer: '/matches/0', rank: 0, verdict: 'wrong' }],
        correctorGroupId: 'jc-1',
        participantId: 'end-user-1',
      },
      { idempotencyKey: 'idem-j' },
    );
    expect(result.id).toBe('j-1');
    expect(result.status).toBe('open');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/corrections');
    expect(req.headers['idempotency-key']).toBe('idem-j');
    expect(JSON.parse(req.body!)).toEqual({
      runId: 'run-1',
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.lookup', args: { name: 'Acme' } }, { tool: 'acme.rank' }],
      mustNotCall: ['acme.refund'],
      answer: 'wrong',
      why: 'Wrong company.',
      items: [{ key: 'c1', pointer: '/matches/0', rank: 0, verdict: 'wrong' }],
      correctorGroupId: 'jc-1',
      participantId: 'end-user-1',
    });
  });

  it('sends only what is given', async () => {
    const stub = jsonFetch(CORRECTION, { status: 201 });
    await clientFor(stub).corrections.create({ runId: 'run-1', answer: 'right' });
    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({ runId: 'run-1', answer: 'right' });
  });

  it('surfaces run-not-finished', async () => {
    const stub = errorFetch(409, { code: 'run-not-finished', message: 'Run has no output yet.' });
    await expect(
      clientFor(stub).corrections.create({ runId: 'run-1', answer: 'right' }),
    ).rejects.toMatchObject({
      error: { code: 'conflict', reason: 'run-not-finished', serverCode: 'run-not-finished' },
    });
  });
});

describe('corrections.list', () => {
  it('GETs /v1/corrections with every filter', async () => {
    const stub = jsonFetch({ data: [CORRECTION], hasMore: true, nextCursor: 'c2' });
    const page = await clientFor(stub).corrections.list({
      limit: 10,
      runId: 'run-1',
      agentId: 'acme.matcher',
      agentVersion: '2.0.0',
      flowId: 'acme.flow',
      status: ['not-fixed', 'wont-fix'],
      sortedTo: 'none',
      from: 'experts',
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-02T00:00:00.000Z',
      correctorGroupId: 'jc-1',
      participantId: 'end-user-1',
      scope: { kind: 'project', projectId: 'proj-1' },
    });
    expect(page.items[0]?.id).toBe('j-1');
    expect(page.nextCursor).toBe('c2');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/corrections');
    expect(url.searchParams.getAll('status')).toEqual(['not-fixed', 'wont-fix']);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '10',
      runId: 'run-1',
      agentId: 'acme.matcher',
      agentVersion: '2.0.0',
      flowId: 'acme.flow',
      status: 'wont-fix',
      sortedTo: 'none',
      from: 'experts',
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-02T00:00:00.000Z',
      correctorGroupId: 'jc-1',
      participantId: 'end-user-1',
      scopeKind: 'project',
      scopeId: 'proj-1',
    });
  });
});

describe('corrections.change', () => {
  it('PATCHes /v1/corrections/{id} with the change and Idempotency-Key', async () => {
    const stub = jsonFetch({ ...CORRECTION, status: 'being-fixed' });
    const got = await clientFor(stub).corrections.change(
      'j-1',
      { sortedTo: 'developer', status: 'being-fixed', link: 'https://github.com/acme/app/pull/7' },
      { idempotencyKey: 'k' },
    );
    expect(got.status).toBe('being-fixed');
    const req = stub.calls[0]!;
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('https://api.example.com/v1/corrections/j-1');
    expect(req.headers['idempotency-key']).toBe('k');
    expect(JSON.parse(req.body!)).toEqual({
      sortedTo: 'developer',
      status: 'being-fixed',
      link: 'https://github.com/acme/app/pull/7',
    });
  });

  it('surfaces a change the status does not allow', async () => {
    const stub = errorFetch(409, {
      code: 'correction-status-change-not-allowed',
      message: 'Not from fixed.',
      details: { from: 'fixed', to: 'being-fixed' },
    });
    await expect(
      clientFor(stub).corrections.change('j-1', { status: 'open' }),
    ).rejects.toMatchObject({
      error: { code: 'conflict', serverCode: 'correction-status-change-not-allowed' },
    });
  });
});

describe('corrections.counts', () => {
  it("GETs /v1/corrections/counts for a project, and an agent's in it", async () => {
    const counts = { open: 3, beingFixed: 1, withOwner: 2, fixed: 5, wontFix: 0, removed: 1 };
    const stub = jsonFetch(counts);
    expect(
      await clientFor(stub).corrections.counts({ projectId: 'proj-1', agentId: 'acme.matcher' }),
    ).toEqual(counts);
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/corrections/counts');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scopeKind: 'project',
      scopeId: 'proj-1',
      agentId: 'acme.matcher',
    });
  });
});

describe('corrections.get', () => {
  it('GETs /v1/corrections/{id} with the copies', async () => {
    const stub = jsonFetch({
      ...CORRECTION,
      run: {
        runId: 'run-1',
        subject: CORRECTION.subject,
        input: {},
        output: { matches: [] },
        capturedAt: '2026-10-01T00:00:00.000Z',
      },
    });
    const got = await clientFor(stub).corrections.get('j/1');
    expect(got.run.output).toEqual({ matches: [] });
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/corrections/j%2F1');
  });
});

describe('corrections.remove', () => {
  it('POSTs /v1/corrections/{id}/remove and returns nothing', async () => {
    const stub = jsonFetch({ correctionId: 'j-1', unregistered: true });
    const result = await clientFor(stub).corrections.remove('j-1', { idempotencyKey: 'k' });
    expect(result).toBeUndefined();
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/corrections/j-1/remove');
    expect(req.headers['idempotency-key']).toBe('k');
  });
});
