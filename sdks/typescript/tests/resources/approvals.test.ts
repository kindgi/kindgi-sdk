// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const TENANT = '00000000-0000-4000-8000-000000000002';

const WIRE_APPROVAL = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: TENANT,
  subjectKind: 'fix-proposal',
  subjectRef: { proposalId: 'p-1' },
  requiredRole: 'standard' as const,
  status: 'pending' as const,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

const WIRE_REVIEWER = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT,
  userId: '55555555-5555-4555-8555-555555555555',
  role: 'standard' as const,
  displayName: 'Alice',
  createdAt: '2026-09-20T00:00:00.000Z',
};

describe('approvals.list / get — /v1/approvals mapping', () => {
  it('GETs /v1/approvals with filter', async () => {
    const stub = jsonFetch({ data: [WIRE_APPROVAL], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.approvals.list({
      status: 'pending',
      requiredRole: 'standard',
      limit: 10,
    });
    expect(page.items[0]?.id).toBe(WIRE_APPROVAL.id);
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('status')).toBe('pending');
    expect(url.searchParams.get('requiredRole')).toBe('standard');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('GETs /v1/approvals/{approvalId}', async () => {
    const stub = jsonFetch(WIRE_APPROVAL);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const a = await client.approvals.get(WIRE_APPROVAL.id as never);
    expect(a.id).toBe(WIRE_APPROVAL.id);
    expect(a.subjectKind).toBe('fix-proposal');
    expect(stub.calls[0]?.url).toBe(`https://api.example.com/v1/approvals/${WIRE_APPROVAL.id}`);
  });

  it('maps 404 approval-not-found onto not-found', async () => {
    const stub = errorFetch(404, {
      code: 'approval-not-found',
      message: 'no such approval',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.approvals.get('nope' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('approvals.decide — reshape to CompleteApprovalResult', () => {
  it('POSTs /v1/approvals/{id}/complete with rationale + value', async () => {
    const wireResult = {
      kind: 'terminal' as const,
      approval: {
        ...WIRE_APPROVAL,
        status: 'approved' as const,
        decidedAt: '2026-09-20T00:01:00.000Z',
      },
      decision: {
        id: 'd-1',
        approvalId: WIRE_APPROVAL.id,
        reviewerId: WIRE_REVIEWER.id,
        decision: 'approve' as const,
        reviewerRoleAtDecision: 'standard' as const,
        decidedAt: '2026-09-20T00:01:00.000Z',
      },
      waitpointResolved: true,
    };
    const stub = jsonFetch(wireResult);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.approvals.decide(WIRE_APPROVAL.id as never, {
      decision: 'approve',
      rationale: 'Looks good',
      value: { note: 'ok' },
      idempotencyKey: 'idem-dec',
    });
    expect(result.kind).toBe('terminal');
    expect(result.waitpointResolved).toBe(true);
    expect(result.decision.decision).toBe('approve');

    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.example.com/v1/approvals/${WIRE_APPROVAL.id}/complete`);
    expect(req.headers['idempotency-key']).toBe('idem-dec');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body.decision).toBe('approve');
    expect(body.rationale).toBe('Looks good');
    expect(body.value).toEqual({ note: 'ok' });
  });
});

describe('approvals.reviewers — /v1/approvals/reviewers sub-resource', () => {
  it('POSTs /v1/approvals/reviewers to register (returns Reviewer row)', async () => {
    const stub = jsonFetch(WIRE_REVIEWER, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const reviewer = await client.approvals.reviewers.register(
      {
        userId: WIRE_REVIEWER.userId as never,
        role: 'standard',
        displayName: 'Alice',
      },
      { idempotencyKey: 'idem-reg' },
    );
    expect(reviewer.id).toBe(WIRE_REVIEWER.id);
    expect(reviewer.role).toBe('standard');
    const req = stub.calls[0]!;
    expect(req.url).toBe('https://api.example.com/v1/approvals/reviewers');
    expect(req.headers['idempotency-key']).toBe('idem-reg');
  });

  it('GETs /v1/approvals/reviewers with role filter', async () => {
    const stub = jsonFetch({ data: [WIRE_REVIEWER], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.approvals.reviewers.list({ role: 'standard' });
    expect(page.items[0]?.id).toBe(WIRE_REVIEWER.id);
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('role')).toBe('standard');
  });

  it('GETs /v1/approvals/reviewers/{reviewerId}', async () => {
    const stub = jsonFetch(WIRE_REVIEWER);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const r = await client.approvals.reviewers.get(WIRE_REVIEWER.id as never);
    expect(r.id).toBe(WIRE_REVIEWER.id);
    expect(stub.calls[0]?.url).toBe(
      `https://api.example.com/v1/approvals/reviewers/${WIRE_REVIEWER.id}`,
    );
  });

  it('POSTs unregister and returns UnregisterReviewerResult', async () => {
    const stub = jsonFetch({ reviewerId: WIRE_REVIEWER.id, unregistered: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.approvals.reviewers.deactivate(WIRE_REVIEWER.id as never, {
      idempotencyKey: 'idem-un',
    });
    expect(result.unregistered).toBe(true);
    expect(result.reviewerId).toBe(WIRE_REVIEWER.id);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      `https://api.example.com/v1/approvals/reviewers/${WIRE_REVIEWER.id}/unregister`,
    );
    expect(req.headers['idempotency-key']).toBe('idem-un');
  });

  it('maps 404 reviewer-not-found onto not-found', async () => {
    const stub = errorFetch(404, {
      code: 'reviewer-not-found',
      message: 'no such reviewer',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.approvals.reviewers.get('nope' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('approvals.audit.export — POST /v1/approvals/{id}/audit-bundle', () => {
  it('returns signed bundle envelope', async () => {
    const wireBundle = {
      approvalId: WIRE_APPROVAL.id,
      bundle: Buffer.from(JSON.stringify({ hi: 'there' })).toString('base64'),
      bundleSchemaVersion: 1,
      algorithm: 'ed25519' as const,
      signingKeyId: 'key-primary',
      signature: 'sig-b64',
      publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
      canonicalization: 'sorted-key-json' as const,
      exportedAt: '2026-09-20T00:02:00.000Z',
    };
    const stub = jsonFetch(wireBundle);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const bundle = await client.approvals.audit.export({
      approvalId: WIRE_APPROVAL.id as never,
      signingKeyId: 'key-primary',
      includeMessages: true,
      idempotencyKey: 'idem-ab',
    });

    expect(bundle.algorithm).toBe('ed25519');
    expect(bundle.signingKeyId).toBe('key-primary');
    const req = stub.calls[0]!;
    expect(req.url).toBe(`https://api.example.com/v1/approvals/${WIRE_APPROVAL.id}/audit-bundle`);
    expect(req.headers['idempotency-key']).toBe('idem-ab');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body.signingKeyId).toBe('key-primary');
    expect(body.includeMessages).toBe(true);
  });

  it('maps 404 signing-not-configured onto not-found', async () => {
    const stub = errorFetch(404, {
      code: 'signing-not-configured',
      message: 'no signing key binding',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.approvals.audit.export({
        approvalId: WIRE_APPROVAL.id as never,
        signingKeyId: 'key-primary',
      }),
    ).rejects.toMatchObject({ error: { code: 'not-found' } });
  });
});

describe('approvals not-yet-wired surface', () => {
  it('batch / assign / completeToken / audit.get / audit.list / reviewers.updateRole throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.approvals.batch({
        ids: ['a-1' as never],
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ error: { code: 'not-yet-wired', method: 'approvals.batch' } });

    await expect(client.approvals.assign('a-1' as never, 'r-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'approvals.assign' },
    });

    await expect(
      client.approvals.completeToken('a-1' as never, { value: 42 }),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'approvals.completeToken' },
    });

    await expect(client.approvals.audit.get('bundle-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'approvals.audit.get' },
    });

    await expect(client.approvals.audit.list()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'approvals.audit.list' },
    });

    await expect(
      client.approvals.reviewers.updateRole('r-1' as never, 'senior'),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'approvals.reviewers.updateRole' },
    });

    expect(stub.calls.length).toBe(0);
  });
});

describe('approvals.list — status, assignedTo, order (a reviewer inbox in one read)', () => {
  it('sends a single status as ?status=', async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.approvals.list({ status: 'approved' });

    expect(new URL(stub.calls[0]?.url ?? '').searchParams.getAll('status')).toEqual(['approved']);
  });

  it('sends several statuses comma-separated, a one-element list as that status, an empty list as no filter', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.approvals.list({ status: ['pending', 'assigned', 'in_review'] });
    await client.approvals.list({ status: ['approved'] });
    await client.approvals.list({ status: [] });

    expect(stub.calls.map((c) => new URL(c.url).searchParams.getAll('status'))).toEqual([
      ['pending,assigned,in_review'],
      ['approved'],
      [],
    ]);
  });

  it("sends assignedTo=me and order, and the page says which order it's in", async () => {
    const stub = jsonFetch({ data: [], hasMore: false, order: 'asc' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.approvals.list({ assignedTo: 'me', order: 'asc' });

    const sent = new URL(stub.calls[0]?.url ?? '').searchParams;
    expect([sent.get('assignedTo'), sent.get('order')]).toEqual(['me', 'asc']);
    expect(page.order).toBe('asc');
  });

  it("a page from a runtime that doesn't say has no order (it's newest first)", async () => {
    const stub = jsonFetch({ data: [], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.approvals.list({ order: 'asc' });

    expect(page.order).toBeUndefined();
  });
});

describe('approvals.list — waitTokenIds (T272)', () => {
  it('repeats ?waitTokenId= once per token, in order; an empty list sends none', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.approvals.list({ waitTokenIds: ['tok-a', 'tok-b'] });
    await client.approvals.list({ waitTokenIds: [] });

    expect(stub.calls.map((c) => new URL(c.url).searchParams.getAll('waitTokenId'))).toEqual([
      ['tok-a', 'tok-b'],
      [],
    ]);
  });
});
