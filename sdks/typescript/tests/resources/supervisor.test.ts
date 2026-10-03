// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const TENANT = '00000000-0000-4000-8000-000000000002';
const SUPERVISOR_ID = 'sup-citation';

const WIRE_PROPOSAL = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: TENANT,
  supervisorId: SUPERVISOR_ID,
  agentId: 'acme.citation-verifier',
  agentVersion: '1.0.0',
  tier: 'prompt' as const,
  change: { before: 'old prompt', after: 'new prompt' },
  patternRefs: [],
  hypothesis: 'Tighter prompt reduces fabrications',
  proposerRuleId: 'prompt-tighten-v1',
  status: 'draft' as const,
  fingerprint: 'abc123',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

describe('supervisor.proposals.draft — POST /v1/proposals with X-Supervisor-Id', () => {
  it('POSTs body + threads supervisor header', async () => {
    const stub = jsonFetch(WIRE_PROPOSAL, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const proposal = await client.supervisor.proposals.draft({
      supervisorId: SUPERVISOR_ID as never,
      agentId: 'acme.citation-verifier' as never,
      agentVersion: '1.0.0',
      tier: 'prompt',
      change: { before: 'old prompt', after: 'new prompt' },
      patternRefs: [],
      hypothesis: 'Tighter prompt reduces fabrications',
      proposerRuleId: 'prompt-tighten-v1',
      idempotencyKey: 'idem-1',
    });

    expect(proposal.id).toBe(WIRE_PROPOSAL.id);
    expect(proposal.status).toBe('draft');

    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/proposals');
    expect(req.headers['x-supervisor-id']).toBe(SUPERVISOR_ID);
    expect(req.headers['idempotency-key']).toBe('idem-1');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body.agentId).toBe('acme.citation-verifier');
    expect(body.tier).toBe('prompt');
    expect(body.hypothesis).toBe('Tighter prompt reduces fabrications');
  });
});

describe('supervisor.proposals.list / get — GET /v1/proposals with supervisor header', () => {
  it('lists proposals with filter + threads header', async () => {
    const stub = jsonFetch({ data: [WIRE_PROPOSAL], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.supervisor.proposals.list({
      supervisorId: SUPERVISOR_ID as never,
      status: 'draft',
      tier: 'prompt',
      limit: 25,
    });
    expect(page.items[0]?.id).toBe(WIRE_PROPOSAL.id);

    const req = stub.calls[0]!;
    expect(req.headers['x-supervisor-id']).toBe(SUPERVISOR_ID);
    const url = new URL(req.url);
    expect(url.searchParams.get('status')).toBe('draft');
    expect(url.searchParams.get('tier')).toBe('prompt');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('gets a proposal by id + threads header', async () => {
    const stub = jsonFetch(WIRE_PROPOSAL);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const p = await client.supervisor.proposals.get(
      SUPERVISOR_ID as never,
      WIRE_PROPOSAL.id as never,
    );
    expect(p.id).toBe(WIRE_PROPOSAL.id);
    expect(stub.calls[0]?.url).toBe(`https://api.example.com/v1/proposals/${WIRE_PROPOSAL.id}`);
    expect(stub.calls[0]?.headers['x-supervisor-id']).toBe(SUPERVISOR_ID);
  });

  it('maps 404 proposal-not-found onto not-found', async () => {
    const stub = errorFetch(404, {
      code: 'proposal-not-found',
      message: 'no such proposal',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.supervisor.proposals.get(SUPERVISOR_ID as never, 'nope' as never),
    ).rejects.toMatchObject({ error: { code: 'not-found' } });
  });
});

describe('supervisor.proposals.dryRun — reshape to DryRunProposalResult', () => {
  it('returns { proposal, passed }', async () => {
    const stub = jsonFetch({
      proposal: { ...WIRE_PROPOSAL, status: 'dry-run-passed' },
      passed: true,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.supervisor.proposals.dryRun(
      SUPERVISOR_ID as never,
      WIRE_PROPOSAL.id as never,
      {
        datasetId: 'ds_citations' as never,
        datasetVersion: '1.0.0',
        criterion: { kind: 'strict-improvement', baselinePassRate: 0.8, minDelta: 0.05 },
        idempotencyKey: 'idem-dr',
      },
    );

    expect(result.passed).toBe(true);
    expect(result.proposal.status).toBe('dry-run-passed');
    const req = stub.calls[0]!;
    expect(req.url).toBe(`https://api.example.com/v1/proposals/${WIRE_PROPOSAL.id}/dry-run`);
    expect(req.headers['idempotency-key']).toBe('idem-dr');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body.datasetId).toBe('ds_citations');
    expect((body.criterion as { kind: string }).kind).toBe('strict-improvement');
  });

  it('maps 409 proposal-invalid-state-transition onto conflict', async () => {
    const stub = errorFetch(409, {
      code: 'proposal-invalid-state-transition',
      message: 'cannot dry-run an applied proposal',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.supervisor.proposals.dryRun(SUPERVISOR_ID as never, WIRE_PROPOSAL.id as never, {
        datasetId: 'ds' as never,
        datasetVersion: '1.0.0',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.9 },
      }),
    ).rejects.toMatchObject({
      error: { code: 'conflict', reason: 'proposal-invalid-state-transition' },
    });
  });
});

describe('supervisor.proposals.submitForReview — reshape to SubmitReviewProposalResult', () => {
  it('returns { proposal, approvalId, metaFix }', async () => {
    const stub = jsonFetch({
      proposal: { ...WIRE_PROPOSAL, status: 'proposed-for-review' },
      approvalId: '22222222-2222-4222-8222-222222222222',
      metaFix: false,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.supervisor.proposals.submitForReview(
      SUPERVISOR_ID as never,
      WIRE_PROPOSAL.id as never,
      { requiredRole: 'senior', idempotencyKey: 'idem-sr' },
    );
    expect(result.metaFix).toBe(false);
    expect(result.approvalId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.proposal.status).toBe('proposed-for-review');
    const req = stub.calls[0]!;
    expect(req.headers['idempotency-key']).toBe('idem-sr');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body.requiredRole).toBe('senior');
  });
});

describe('supervisor.proposals.apply / rollback / withdraw', () => {
  it('apply POSTs + returns ApplyProposalResult', async () => {
    const stub = jsonFetch({
      proposalId: WIRE_PROPOSAL.id,
      appliedVersion: '1.0.1',
      appliedAt: '2026-09-20T00:01:00.000Z',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.supervisor.proposals.apply(
      SUPERVISOR_ID as never,
      WIRE_PROPOSAL.id as never,
      { newVersion: '1.0.1' },
    );
    expect(result.appliedVersion).toBe('1.0.1');
    expect(stub.calls[0]?.url).toBe(
      `https://api.example.com/v1/proposals/${WIRE_PROPOSAL.id}/apply`,
    );
    const body = JSON.parse(stub.calls[0]?.body!) as Record<string, unknown>;
    expect(body.newVersion).toBe('1.0.1');
  });

  it('rollback POSTs with reason', async () => {
    const stub = jsonFetch({
      proposalId: WIRE_PROPOSAL.id,
      rolledBackAt: '2026-09-20T00:02:00.000Z',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.supervisor.proposals.rollback(
      SUPERVISOR_ID as never,
      WIRE_PROPOSAL.id as never,
      { reason: 'regression on citation pass rate' },
    );
    expect(result.rolledBackAt).toBe('2026-09-20T00:02:00.000Z');
    const body = JSON.parse(stub.calls[0]?.body!) as Record<string, unknown>;
    expect(body.reason).toBe('regression on citation pass rate');
  });

  it('withdraw POSTs with reason + returns FixProposal', async () => {
    const stub = jsonFetch({ ...WIRE_PROPOSAL, status: 'withdrawn' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const p = await client.supervisor.proposals.withdraw(
      SUPERVISOR_ID as never,
      WIRE_PROPOSAL.id as never,
      { reason: 'obsolete' },
    );
    expect(p.status).toBe('withdrawn');
    expect(stub.calls[0]?.url).toBe(
      `https://api.example.com/v1/proposals/${WIRE_PROPOSAL.id}/withdraw`,
    );
  });
});

describe('supervisor not-yet-wired surface', () => {
  it('supervisor CRUD + reflectReview throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.supervisor.define({
        id: 'sup-x',
        version: '1.0.0',
        name: 'X',
        triggerGuardrails: [],
        proposerTiers: ['prompt'],
      }),
    ).rejects.toMatchObject({ error: { code: 'not-yet-wired', method: 'supervisor.define' } });

    await expect(client.supervisor.get('sup-x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.get' },
    });
    await expect(client.supervisor.list()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.list' },
    });
    await expect(client.supervisor.versions('sup-x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.versions' },
    });
    await expect(client.supervisor.delete('sup-x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.delete' },
    });
    await expect(
      client.supervisor.proposals.reflectReview(SUPERVISOR_ID as never, WIRE_PROPOSAL.id as never, {
        decision: 'approved',
      }),
    ).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.proposals.reflectReview' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
