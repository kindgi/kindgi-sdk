// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type {
  AgentId,
  ApprovalId,
  Cursor,
  FixProposalId,
  SupervisorId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  FixProposal,
  FixProposalStatus,
  PassCriterion,
  PatternRef,
  ProposedChange,
  RunHandlerBinding,
  SupervisorBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Supervisor proposals route tests.
 *
 * The `SupervisorBinding` is caller-plugged — these tests use a small
 * in-memory binding that faithfully models the runtime state machine
 * (`draft → dry-running → dry-run-passed/failed → proposed-for-review
 * → approved/rejected → applied → rolled-back`, plus withdraw from
 * any non-terminal state). No DB access — the routes only talk to
 * the binding.
 *
 * The binding also tracks a small "approval" ledger so the
 * submit-review integration test can verify that a submit call
 * produces a HITL approval row without spinning up the real HITL DB.
 */

const tenantId = randomUUID() as TenantId;
const supervisorId = 'sup.acme-quality' as SupervisorId;
const TOKEN = 'proposals-token-abc';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

const NON_TERMINAL: ReadonlySet<FixProposalStatus> = new Set([
  'draft',
  'dry-running',
  'dry-run-passed',
  'dry-run-failed',
  'proposed-for-review',
]);

interface Runtime {
  readonly proposals: Map<string, FixProposal>;
  readonly approvals: Map<
    string,
    { readonly proposalId: FixProposalId; readonly requiredRole: string }
  >;
  readonly agentVersions: Map<string, Set<string>>;
  /** Fingerprint dedup index: `(supervisorId, fingerprint)` → id. */
  readonly fingerprintIndex: Map<string, FixProposalId>;
  /** Optional override for the next dryRun's `passed` outcome. Default true. */
  nextDryRunPasses: boolean;
  /** Optional override for the next submitReview's metaFix flag. */
  nextSubmitReviewMetaFix: boolean;
  /** Optional override: next submit-review returns ground-layer violation. */
  nextSubmitReviewGroundViolation: { guardrailId: string; reason: string } | null;
}

function fingerprintOf(input: {
  supervisorId: SupervisorId;
  tier: ProposedChange['tier'];
  agentId: AgentId;
  agentVersion: string;
  change: unknown;
}): string {
  return `${input.supervisorId}:${input.tier}:${input.agentId}:${input.agentVersion}:${JSON.stringify(input.change)}`;
}

function makeRuntime(): Runtime {
  return {
    proposals: new Map(),
    approvals: new Map(),
    agentVersions: new Map(),
    fingerprintIndex: new Map(),
    nextDryRunPasses: true,
    nextSubmitReviewMetaFix: false,
    nextSubmitReviewGroundViolation: null,
  };
}

function bindingFromRuntime(rt: Runtime): SupervisorBinding {
  return {
    async listProposals({ supervisorId: sid, limit, cursor, status, agentId, tier }) {
      const all = [...rt.proposals.values()]
        .filter((p) => (p.supervisorId as unknown as string) === (sid as unknown as string))
        .filter((p) => (status === undefined ? true : p.status === status))
        .filter((p) =>
          agentId === undefined
            ? true
            : (p.agentId as unknown as string) === (agentId as unknown as string),
        )
        .filter((p) => (tier === undefined ? true : p.tier === tier))
        .sort((a, b) =>
          (a.createdAt as unknown as string).localeCompare(b.createdAt as unknown as string),
        );
      let startAt = 0;
      if (cursor !== undefined) {
        const cur = cursor as unknown as string;
        startAt = all.findIndex((p) => (p.createdAt as unknown as string) > cur);
        if (startAt < 0) startAt = all.length;
      }
      const slice = all.slice(startAt, startAt + limit);
      const last = slice[slice.length - 1];
      const hasMore = startAt + slice.length < all.length;
      return {
        data: slice,
        ...(hasMore &&
          last !== undefined && {
            nextCursor: last.createdAt as unknown as string as unknown as Cursor,
          }),
      };
    },
    async getProposal({ supervisorId: sid, proposalId }) {
      const p = rt.proposals.get(proposalId as unknown as string);
      if (p === undefined) return null;
      if ((p.supervisorId as unknown as string) !== (sid as unknown as string)) return null;
      return p;
    },
    async draftProposal(input) {
      const fp = fingerprintOf({
        supervisorId: input.supervisorId,
        tier: input.tier,
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        change: input.change,
      });
      const dedupKey = `${input.supervisorId as unknown as string}:${fp}`;
      const existingId = rt.fingerprintIndex.get(dedupKey);
      if (existingId !== undefined) {
        const existing = rt.proposals.get(existingId as unknown as string);
        if (existing !== undefined && NON_TERMINAL.has(existing.status)) {
          return { kind: 'dedup', proposal: existing };
        }
      }
      const now = new Date().toISOString() as Timestamp;
      const id = randomUUID() as FixProposalId;
      const proposal: FixProposal = {
        id,
        tenantId: input.tenantId,
        supervisorId: input.supervisorId,
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        tier: input.tier,
        change: input.change,
        patternRefs: input.patternRefs,
        hypothesis: input.hypothesis,
        proposerRuleId: input.proposerRuleId,
        status: 'draft',
        fingerprint: fp,
        createdAt: now,
        updatedAt: now,
      };
      rt.proposals.set(id as unknown as string, proposal);
      rt.fingerprintIndex.set(dedupKey, id);
      return { kind: 'ok', proposal };
    },
    async dryRunProposal({ proposalId }) {
      const p = rt.proposals.get(proposalId as unknown as string);
      if (p === undefined) return { kind: 'not-found', proposalId };
      if (p.status !== 'draft' && p.status !== 'dry-run-failed') {
        return {
          kind: 'invalid-transition',
          proposalId,
          from: p.status,
          to: 'dry-running' as FixProposalStatus,
        };
      }
      const passed = rt.nextDryRunPasses;
      const now = new Date().toISOString() as Timestamp;
      const next: FixProposal = {
        ...p,
        status: passed ? 'dry-run-passed' : 'dry-run-failed',
        updatedAt: now,
      };
      rt.proposals.set(proposalId as unknown as string, next);
      return { kind: 'ok', proposal: next, passed };
    },
    async submitReview({ proposalId }) {
      const p = rt.proposals.get(proposalId as unknown as string);
      if (p === undefined) return { kind: 'not-found', proposalId };
      if (p.status !== 'dry-run-passed') {
        return {
          kind: 'invalid-transition',
          proposalId,
          from: p.status,
          to: 'proposed-for-review' as FixProposalStatus,
        };
      }
      if (rt.nextSubmitReviewGroundViolation !== null) {
        const v = rt.nextSubmitReviewGroundViolation;
        return {
          kind: 'ground-layer-violation',
          proposalId,
          guardrailId: v.guardrailId,
          reason: v.reason,
        };
      }
      const approvalId = randomUUID() as ApprovalId;
      rt.approvals.set(approvalId as unknown as string, {
        proposalId,
        requiredRole: rt.nextSubmitReviewMetaFix ? 'senior' : 'standard',
      });
      const now = new Date().toISOString() as Timestamp;
      const next: FixProposal = {
        ...p,
        status: 'proposed-for-review',
        reviewApprovalId: approvalId,
        updatedAt: now,
      };
      rt.proposals.set(proposalId as unknown as string, next);
      return {
        kind: 'ok',
        proposal: next,
        approvalId,
        metaFix: rt.nextSubmitReviewMetaFix,
      };
    },
    async applyProposal({ proposalId, newVersion }) {
      const p = rt.proposals.get(proposalId as unknown as string);
      if (p === undefined) return { kind: 'not-found', proposalId };
      if (p.status !== 'approved') {
        return {
          kind: 'invalid-transition',
          proposalId,
          from: p.status,
          to: 'applied' as FixProposalStatus,
        };
      }
      const bumped = newVersion ?? bumpPatch(p.agentVersion);
      const now = new Date().toISOString() as Timestamp;
      const next: FixProposal = {
        ...p,
        status: 'applied',
        appliedVersion: bumped,
        appliedAt: now,
        updatedAt: now,
      };
      rt.proposals.set(proposalId as unknown as string, next);
      const key = p.agentId as unknown as string;
      const versions = rt.agentVersions.get(key) ?? new Set<string>();
      versions.add(bumped);
      rt.agentVersions.set(key, versions);
      return {
        kind: 'ok',
        proposalId,
        appliedVersion: bumped,
        appliedAt: now,
      };
    },
    async rollbackProposal({ proposalId, reason }) {
      const p = rt.proposals.get(proposalId as unknown as string);
      if (p === undefined) return { kind: 'not-found', proposalId };
      if (p.status !== 'applied') {
        return {
          kind: 'invalid-transition',
          proposalId,
          from: p.status,
          to: 'rolled-back' as FixProposalStatus,
        };
      }
      const now = new Date().toISOString() as Timestamp;
      const next: FixProposal = {
        ...p,
        status: 'rolled-back',
        resolutionReason: reason,
        updatedAt: now,
      };
      rt.proposals.set(proposalId as unknown as string, next);
      if (p.appliedVersion !== undefined) {
        const versions = rt.agentVersions.get(p.agentId as unknown as string);
        versions?.delete(p.appliedVersion);
      }
      return { kind: 'ok', proposalId, rolledBackAt: now };
    },
    async withdrawProposal({ proposalId, reason }) {
      const p = rt.proposals.get(proposalId as unknown as string);
      if (p === undefined) return { kind: 'not-found', proposalId };
      if (!NON_TERMINAL.has(p.status)) {
        return {
          kind: 'invalid-transition',
          proposalId,
          from: p.status,
          to: 'withdrawn' as FixProposalStatus,
        };
      }
      const now = new Date().toISOString() as Timestamp;
      const next: FixProposal = {
        ...p,
        status: 'withdrawn',
        resolutionReason: reason,
        updatedAt: now,
      };
      rt.proposals.set(proposalId as unknown as string, next);
      return { kind: 'ok', proposal: next };
    },
    async queryObservations() {
      return { kind: 'ok', page: { data: [] } };
    },
  };
}

function bumpPatch(v: string): string {
  const parts = v.split('.');
  if (parts.length !== 3) return v;
  const [maj, min, pat] = parts;
  return `${maj}.${min}.${Number.parseInt(pat ?? '0', 10) + 1}`;
}

function makeApp() {
  const rt = makeRuntime();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    supervisor: bindingFromRuntime(rt),
  });
  return { app, rt };
}

// -------------------- helpers --------------------

const draftHeaders = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  'x-supervisor-id': supervisorId as unknown as string,
};

const draftBody = (
  overrides: Partial<{ agentId: string; agentVersion: string; hypothesis: string }> = {},
) => ({
  agentId: overrides.agentId ?? 'acme.drafting',
  agentVersion: overrides.agentVersion ?? '1.0.0',
  tier: 'prompt' as const,
  change: { kind: 'append' as const, text: '\nAdditional guidance: always cite.' },
  patternRefs: [
    {
      kind: 'guardrail-violation' as const,
      key: 'must-cite',
      count: 4,
      firstSeenAt: '2026-09-10T00:00:00Z',
      lastSeenAt: '2026-09-19T00:00:00Z',
      sampleConversations: [randomUUID()],
    } as unknown as PatternRef,
  ],
  hypothesis:
    overrides.hypothesis ?? 'Explicit citation guidance should reduce must-cite violations.',
  proposerRuleId: 'must-cite-missing',
});

async function seedDraft(app: ReturnType<typeof makeApp>['app']): Promise<{ id: string }> {
  const res = await app.request('/v1/proposals', {
    method: 'POST',
    headers: draftHeaders,
    body: JSON.stringify(draftBody()),
  });
  if (res.status !== 201) throw new Error(`seed draft failed: ${res.status}`);
  return (await res.json()) as { id: string };
}

// -------------------- tests --------------------

describe('API — proposals X-Supervisor-Id gate', () => {
  test('missing header → 400 supervisor-header-missing', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/proposals', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('supervisor-header-missing');
  });
});

describe('API — proposals list', () => {
  test('empty supervisor → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/proposals', { headers: draftHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('list filters by status + tier + agentId', async () => {
    const { app, rt } = makeApp();
    // Draft three proposals with distinct shapes.
    await app.request('/v1/proposals', {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify(draftBody({ agentId: 'acme.a' })),
    });
    await app.request('/v1/proposals', {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify(draftBody({ agentId: 'acme.b' })),
    });
    // Move one to dry-run-passed by advancing state manually via the binding path.
    const firstId = [...rt.proposals.keys()][0];
    const dr = await app.request(`/v1/proposals/${firstId}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds-1',
        datasetVersion: '1.0.0',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.9 },
      }),
    });
    expect(dr.status).toBe(200);

    const byStatus = await app.request('/v1/proposals?status=dry-run-passed', {
      headers: draftHeaders,
    });
    const byStatusBody = (await byStatus.json()) as { data: Array<{ id: string }> };
    expect(byStatusBody.data).toHaveLength(1);
    expect(byStatusBody.data[0]?.id).toBe(firstId);

    const byAgent = await app.request('/v1/proposals?agentId=acme.b', { headers: draftHeaders });
    const byAgentBody = (await byAgent.json()) as { data: Array<{ agentId: string }> };
    expect(byAgentBody.data).toHaveLength(1);
    expect(byAgentBody.data[0]?.agentId).toBe('acme.b');

    const byTier = await app.request('/v1/proposals?tier=prompt', { headers: draftHeaders });
    const byTierBody = (await byTier.json()) as { data: unknown[] };
    expect(byTierBody.data).toHaveLength(2);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app } = makeApp();
    // Seed 5 proposals with distinct hypotheses (dedup keys off `change` +
    // `agentVersion`; distinct agentVersions here to avoid dedup).
    for (const v of ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4']) {
      const res = await app.request('/v1/proposals', {
        method: 'POST',
        headers: draftHeaders,
        body: JSON.stringify(draftBody({ agentVersion: v })),
      });
      expect(res.status).toBe(201);
      // Space out createdAt so cursor ordering is deterministic.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const first = await app.request('/v1/proposals?limit=2', { headers: draftHeaders });
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/proposals?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: draftHeaders },
    );
    const secondBody = (await second.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(secondBody.data).toHaveLength(2);
    expect(secondBody.hasMore).toBe(true);
    // Ensure no duplicate ids.
    const seen = new Set([...firstBody.data.map((p) => p.id), ...secondBody.data.map((p) => p.id)]);
    expect(seen.size).toBe(4);
  });

  test('bad status filter → 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/proposals?status=nonsense', { headers: draftHeaders });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });
});

describe('API — proposals draft', () => {
  test('draft roundtrip → 201 with proposal shape', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/proposals', {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify(draftBody()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string; tier: string };
    expect(body.status).toBe('draft');
    expect(body.tier).toBe('prompt');

    const get = await app.request(`/v1/proposals/${body.id}`, { headers: draftHeaders });
    expect(get.status).toBe(200);
  });

  test('missing hypothesis → 400', async () => {
    const { app } = makeApp();
    const bad: Partial<ReturnType<typeof draftBody>> = { ...draftBody() };
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes requires delete
    delete bad.hypothesis;
    const res = await app.request('/v1/proposals', {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
  });

  test('duplicate draft short-circuits + X-Proposal-Deduped header', async () => {
    const { app } = makeApp();
    const first = await app.request('/v1/proposals', {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify(draftBody()),
    });
    const firstBody = (await first.json()) as { id: string };
    const second = await app.request('/v1/proposals', {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify(draftBody()),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Proposal-Deduped')).toBe('true');
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);
  });
});

describe('API — proposals dry-run', () => {
  test('dry-run happy path → dry-run-passed', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    const res = await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds-citations',
        datasetVersion: '1.0.0',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.9 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { status: string }; passed: boolean };
    expect(body.proposal.status).toBe('dry-run-passed');
    expect(body.passed).toBe(true);
  });

  test('dry-run-failed path when criterion misses', async () => {
    const { app, rt } = makeApp();
    rt.nextDryRunPasses = false;
    const drafted = await seedDraft(app);
    const res = await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds-citations',
        datasetVersion: '1.0.0',
        criterion: {
          kind: 'strict-improvement',
          baselinePassRate: 0.7,
          minDelta: 0.2,
        } satisfies PassCriterion,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { status: string }; passed: boolean };
    expect(body.proposal.status).toBe('dry-run-failed');
    expect(body.passed).toBe(false);
  });

  test('dry-run on unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request(`/v1/proposals/${randomUUID()}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'x',
        datasetVersion: '1',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.5 },
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('proposal-not-found');
  });

  test('malformed criterion → 400', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    const res = await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'x',
        datasetVersion: '1',
        criterion: { kind: 'nonsense' },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('API — proposals submit-review', () => {
  test('submit-review from dry-run-passed → 200 + approval row created', async () => {
    const { app, rt } = makeApp();
    const drafted = await seedDraft(app);
    // Advance to dry-run-passed via the dry-run route.
    await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds',
        datasetVersion: '1',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.5 },
      }),
    });
    const res = await app.request(`/v1/proposals/${drafted.id}/submit-review`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: { status: string; reviewApprovalId: string };
      approvalId: string;
      metaFix: boolean;
    };
    expect(body.proposal.status).toBe('proposed-for-review');
    expect(body.approvalId).toBeTruthy();
    expect(body.proposal.reviewApprovalId).toBe(body.approvalId);
    // Verify the binding actually created an approval row.
    expect(rt.approvals.get(body.approvalId)).toBeTruthy();
  });

  test('submit-review from `draft` (invalid state) → 409', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    const res = await app.request(`/v1/proposals/${drafted.id}/submit-review`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: { from?: string } } };
    expect(body.error.code).toBe('proposal-invalid-state-transition');
    expect(body.error.details?.from).toBe('draft');
  });

  test('submit-review with requiredRole override', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds',
        datasetVersion: '1',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.5 },
      }),
    });
    const res = await app.request(`/v1/proposals/${drafted.id}/submit-review`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({ requiredRole: 'senior' }),
    });
    expect(res.status).toBe(200);
  });

  test('ground-layer violation → 422', async () => {
    const { app, rt } = makeApp();
    rt.nextSubmitReviewGroundViolation = {
      guardrailId: 'never-target-own-ground-layer',
      reason: 'proposal targets the supervisor itself',
    };
    const drafted = await seedDraft(app);
    await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds',
        datasetVersion: '1',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.5 },
      }),
    });
    const res = await app.request(`/v1/proposals/${drafted.id}/submit-review`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details?: { guardrailId?: string } };
    };
    expect(body.error.code).toBe('ground-layer-violation');
    expect(body.error.details?.guardrailId).toBe('never-target-own-ground-layer');
  });
});

describe('API — proposals apply / rollback', () => {
  async function advanceToApproved(
    app: ReturnType<typeof makeApp>['app'],
    rt: ReturnType<typeof makeApp>['rt'],
  ): Promise<string> {
    const drafted = await seedDraft(app);
    await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds',
        datasetVersion: '1',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.5 },
      }),
    });
    await app.request(`/v1/proposals/${drafted.id}/submit-review`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    // Simulate a reviewer approve — flip binding state directly (mirrors what
    // `reflectReviewOutcome` would do after HITL approval).
    const stored = rt.proposals.get(drafted.id) as FixProposal;
    rt.proposals.set(drafted.id, { ...stored, status: 'approved' });
    return drafted.id;
  }

  test('apply happy path → agent registry gains a new version', async () => {
    const { app, rt } = makeApp();
    const proposalId = await advanceToApproved(app, rt);
    const res = await app.request(`/v1/proposals/${proposalId}/apply`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposalId: string;
      appliedVersion: string;
      appliedAt: string;
    };
    expect(body.proposalId).toBe(proposalId);
    expect(body.appliedVersion).toBe('1.0.1');
    expect(rt.agentVersions.get('acme.drafting')?.has('1.0.1')).toBe(true);
  });

  test('apply on non-approved (dry-run-passed) → 409', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    await app.request(`/v1/proposals/${drafted.id}/dry-run`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({
        datasetId: 'ds',
        datasetVersion: '1',
        criterion: { kind: 'min-pass-rate', minPassRate: 0.5 },
      }),
    });
    const res = await app.request(`/v1/proposals/${drafted.id}/apply`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('proposal-invalid-state-transition');
  });

  test('rollback happy path', async () => {
    const { app, rt } = makeApp();
    const proposalId = await advanceToApproved(app, rt);
    await app.request(`/v1/proposals/${proposalId}/apply`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    const res = await app.request(`/v1/proposals/${proposalId}/rollback`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({ reason: 'discovered regression on prod traffic' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposalId: string; rolledBackAt: string };
    expect(body.proposalId).toBe(proposalId);
    // Version removed from the registry.
    expect(rt.agentVersions.get('acme.drafting')?.has('1.0.1')).toBe(false);
  });

  test('rollback on non-applied → 409', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    const res = await app.request(`/v1/proposals/${drafted.id}/rollback`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({ reason: 'oops' }),
    });
    expect(res.status).toBe(409);
  });

  test('apply with explicit newVersion override', async () => {
    const { app, rt } = makeApp();
    const proposalId = await advanceToApproved(app, rt);
    const res = await app.request(`/v1/proposals/${proposalId}/apply`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({ newVersion: '2.0.0' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appliedVersion: string };
    expect(body.appliedVersion).toBe('2.0.0');
  });
});

describe('API — proposals withdraw', () => {
  test('withdraw from draft → 200', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    const res = await app.request(`/v1/proposals/${drafted.id}/withdraw`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({ reason: 'no longer relevant' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; resolutionReason: string };
    expect(body.status).toBe('withdrawn');
    expect(body.resolutionReason).toBe('no longer relevant');
  });

  test('withdraw from a terminal state → 409', async () => {
    const { app, rt } = makeApp();
    const drafted = await seedDraft(app);
    // Force to a terminal state ("applied" is terminal).
    const stored = rt.proposals.get(drafted.id) as FixProposal;
    rt.proposals.set(drafted.id, { ...stored, status: 'applied' });
    const res = await app.request(`/v1/proposals/${drafted.id}/withdraw`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({ reason: 'too late' }),
    });
    expect(res.status).toBe(409);
  });

  test('withdraw missing `reason` → 400', async () => {
    const { app } = makeApp();
    const drafted = await seedDraft(app);
    const res = await app.request(`/v1/proposals/${drafted.id}/withdraw`, {
      method: 'POST',
      headers: draftHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('API — proposals not-found + unmounted', () => {
  test('get unknown id → 404', async () => {
    const { app } = makeApp();
    const res = await app.request(`/v1/proposals/${randomUUID()}`, { headers: draftHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('proposal-not-found');
  });

  test('no `supervisor` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/proposals', { headers: draftHeaders });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — proposals scope filter', () => {
  function makeSpy() {
    const rt = makeRuntime();
    const inner = bindingFromRuntime(rt);
    let lastListInput: Parameters<SupervisorBinding['listProposals']>[0] | null = null;
    const spy: SupervisorBinding = {
      ...inner,
      async listProposals(input) {
        lastListInput = input;
        return inner.listProposals(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      supervisor: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/proposals?scopeKind=project&scopeId=${projectId}`, {
      headers: draftHeaders,
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/proposals?scopeKind=org&scopeId=${orgId}`, {
      headers: draftHeaders,
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/proposals', { headers: draftHeaders });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/proposals?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: draftHeaders,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});
