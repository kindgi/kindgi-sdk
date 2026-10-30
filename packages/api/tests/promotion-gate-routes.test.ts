// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Promotions through their gate (evals step 4b): the route resolves the
 * scope's policy, runs the gate on the named comparison and has the
 * binding record the outcome (201 promoted, 202 waiting for approval, 422
 * gate-failed). `…/promotions/check` answers the same, recording nothing.
 * The bindings are fakes that record their inputs.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { LiveScope, ProjectId, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  AgentReleaseBindings,
  CorrectedComparisonSummary,
  TestRun,
  TestRunBinding,
  GatePolicy,
  GatePolicySpec,
  LatestAnswer,
  LivePin,
  LiveResolution,
  Promotion,
  PromotionError,
  PromotionRequestInput,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { highestAsLatest } from './support/latest.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const TOKEN = 'gate-token';
const PROJECT = randomUUID();
const ORG = randomUUID();
const AGENT = 'acme.drafting';
const NOW = new Date();

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
};
const auth = { authorization: `Bearer ${TOKEN}` };
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const PROJECT_SCOPE = { kind: 'project', projectId: PROJECT };

function summary(overrides: Partial<CorrectedComparisonSummary> = {}): CorrectedComparisonSummary {
  const m = {
    baseline: 0.7,
    candidate: 0.8,
    delta: 0.1,
    n: 30,
    weight: 30,
    baselineN: 30,
    baselineWeight: 30,
    direction: 'higher' as const,
  };
  return {
    testRunId: 'eval-1',
    status: 'completed',
    completedAt: NOW.toISOString(),
    testSet: { id: 'acme.set', version: '1.0.0' },
    candidate: { kind: 'agent', agentId: AGENT, version: '1.2.0', pinsDigest: 'sha-120' },
    baseline: { kind: 'recorded', versions: [{ agentId: AGENT, version: '1.1.0', cases: 30 }] },
    scope: { projectId: PROJECT },
    cases: 30,
    diverged: 0,
    refusedWrites: 0,
    errors: 0,
    stopped: 0,
    reads: 'recorded',
    sampling: { models: [] },
    repetitions: 1,
    metrics: { weightedYesShare: m, judgedCoverage: m, weightedPrecisionAtK: { ...m, k: 10 } },
    ...overrides,
  };
}

function policy(spec: GatePolicySpec, scope: LiveScope = PROJECT_SCOPE as LiveScope): GatePolicy {
  return {
    id: 'acme.drafting-prod',
    version: '1.0.0',
    tenantId,
    agentId: AGENT,
    scope,
    spec,
    createdAt: NOW.toISOString() as Timestamp,
  };
}

const PASSING: GatePolicySpec = { metrics: [{ name: 'weightedYesShare', minCandidate: 0.75 }] };
const FAILING: GatePolicySpec = { metrics: [{ name: 'weightedYesShare', minCandidate: 0.9 }] };

function setup(opts: { request?: boolean; gatePolicies?: boolean } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const state: {
    resolved: LiveResolution | null;
    policy: GatePolicy | null;
    testRun: TestRun | null;
    requestError: PromotionError | null;
    projectOrg: string | undefined;
    pins: LivePin[];
    /** Latest in every scope, `null` for none; absent: the highest version. */
    latest?: LatestAnswer | null;
    suspended: boolean;
  } = {
    resolved: null,
    policy: null,
    testRun: null,
    requestError: null,
    projectOrg: undefined,
    pins: [],
    suspended: false,
  };
  const record = (method: string, input: unknown) => calls.push({ method, input });
  const promotionOf = (input: PromotionRequestInput): Promotion => ({
    id: 'promo-1',
    agentId: input.agentId,
    scope: input.scope,
    action: 'promote',
    fromVersion: null,
    toVersion: input.version,
    requestedBy: input.requestedBy,
    createdAt: NOW.toISOString() as Timestamp,
    status: !input.gate.passed
      ? 'refused'
      : input.gate.approval !== undefined
        ? 'pending-approval'
        : 'promoted',
    policy: input.gate.policy,
    checks: input.gate.checks,
    ...(input.gate.passed && input.gate.approval !== undefined && { approvalId: 'appr-1' }),
  });
  const releases: AgentReleaseBindings = {
    live: {
      resolve: async (input) => {
        record('resolve', input);
        return state.resolved;
      },
      list: async () => state.pins,
    },
    // `registry`, declared below, is read when a question is asked.
    latest: {
      latest: async (q) =>
        state.latest === undefined
          ? highestAsLatest({ get: (input) => registry.get(input) }).latest(q)
          : state.latest,
      byProject: async () => [],
    },
    promotions: {
      promote: async (input) => {
        record('promote', input);
        return {
          kind: 'ok',
          value: {
            id: 'promo-0',
            agentId: input.agentId,
            scope: input.scope,
            action: 'promote',
            fromVersion: null,
            toVersion: input.version,
            requestedBy: input.requestedBy,
            createdAt: NOW.toISOString() as Timestamp,
          },
        };
      },
      ...(opts.request !== false && {
        request: async (input: PromotionRequestInput) => {
          record('request', input);
          if (state.requestError !== null) return { kind: 'err', error: state.requestError };
          return { kind: 'ok', value: promotionOf(input) };
        },
      }),
      rollback: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'unused' } }),
      unpin: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'unused' } }),
      list: async () => ({ data: [] }),
      get: async () => null,
    },
    ...(opts.gatePolicies !== false && {
      gatePolicies: {
        resolve: async (input: unknown) => {
          record('policy.resolve', input);
          return state.policy;
        },
        publish: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'x' } }),
        get: async () => null,
        getVersion: async () => null,
        listVersions: async () => [],
        list: async () => ({ data: [] }),
        unregister: async () => ({
          kind: 'err',
          error: { code: 'persistence-error', message: 'x' },
        }),
        reinstate: async () => ({
          kind: 'err',
          error: { code: 'persistence-error', message: 'x' },
        }),
      },
    }),
  };
  const versions: Record<string, { pinsDigest?: string; unregisteredAt?: string }> = {
    '1.0.0': { pinsDigest: 'sha-100' },
    '1.1.0': { pinsDigest: 'sha-110' },
    '1.2.0': { pinsDigest: 'sha-120' },
    '1.3.0': { pinsDigest: 'sha-130', unregisteredAt: '2026-10-01T00:00:00.000Z' },
  };
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const registry: AgentRegistryBinding = {
    get: async () => ({ id: AGENT, version: '1.1.0' }) as never,
    getVersion: async ({ version }) => {
      const v = versions[version as unknown as string];
      return v === undefined ? null : ({ id: AGENT, version, ...v } as never);
    },
    list: unused,
    headExists: unused,
    listVersions: unused,
    publish: unused,
    unregister: unused,
    markLatest: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
    reinstateVersion: unused,
  };
  const testRuns: TestRunBinding = {
    get: async (input) => {
      record('testRuns.get', input);
      return state.testRun;
    },
    start: unused,
    list: unused,
    cancel: unused,
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    agentRegistry: registry,
    agentReleases: releases,
    testRunBinding: testRuns,
    projectSuspended: async (_t: TenantId, projectId: ProjectId) => {
      record('projectSuspended', projectId);
      return state.suspended;
    },
    projectBinding: {
      get: async (_t: TenantId, projectId: ProjectId) => {
        record('projects.get', projectId);
        return {
          id: projectId,
          ...(state.projectOrg !== undefined && { orgId: state.projectOrg }),
        } as never;
      },
    } as never,
  });
  return { app, calls, state };
}

const testRun = (s: CorrectedComparisonSummary | undefined, kind = 'corrections'): TestRun =>
  ({
    id: 'eval-1',
    testRunId: 'eval-1',
    kind,
    status: 'completed',
    ...(s !== undefined && { result: { summary: s, perCase: [] } }),
  }) as never;

const promote = (body: Record<string, unknown> = {}) =>
  post({ version: '1.2.0', scope: PROJECT_SCOPE, testRunId: 'eval-1', ...body });

const methods = (calls: { method: string }[]) => calls.map((c) => c.method);

describe('POST /v1/agents/:agentId/promotions, through the gate', () => {
  test('no policy: recorded as promoted, policy null, no checks → 201', async () => {
    const { app, calls } = setup();
    const res = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      promote({ testRunId: undefined }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'promoted', policy: null, checks: [] });
    const request = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(request.gate).toEqual({
      policy: null,
      checks: [],
      passed: true,
      servingVersion: '1.1.0',
    });
  });

  test('no policy, a binding from before gates (no request): promoted as before', async () => {
    const { app, calls } = setup({ request: false });
    const res = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      promote({ testRunId: undefined }),
    );
    expect(res.status).toBe(201);
    expect(methods(calls)).toEqual(['policy.resolve', 'promote']);
  });

  test("a policy applies, and the binding can't record a gated promotion → 501, nothing promoted", async () => {
    const { app, calls, state } = setup({ request: false });
    state.policy = policy(PASSING);
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'promotion-gate-unsupported',
    );
    expect(methods(calls)).not.toContain('promote');
  });

  test('the gate passes: 201 promoted, with the policy and its checks', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(PASSING);
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'promoted',
      policy: { id: 'acme.drafting-prod', version: '1.0.0' },
    });
    expect((body.checks as { passed: boolean }[]).every((c) => c.passed)).toBe(true);
    const request = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(request.gate).toMatchObject({ passed: true, servingVersion: '1.1.0' });
    expect(request.testRunId).toBe('eval-1');
  });

  test('the gate passes and the policy wants an approval: 202, with the approval id', async () => {
    const { app, calls, state } = setup();
    state.policy = policy({ ...PASSING, approvals: { role: 'admin' } });
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'pending-approval', approvalId: 'appr-1' });
    const request = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(request.gate.approval).toEqual({ role: 'admin', count: 1, separateApprover: true });
  });

  test('the gate fails: 422 gate-failed, the refusal recorded, every check in the details', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(FAILING);
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(error.code).toBe('gate-failed');
    expect(error.message).toContain(
      'The weighted share marked right is 0.8; the policy needs at least 0.9.',
    );
    expect(error.details).toMatchObject({
      promotionId: 'promo-1',
      policy: { id: 'acme.drafting-prod', version: '1.0.0' },
    });
    expect(error.details.checks).toContainEqual(
      expect.objectContaining({ name: 'metric.weightedYesShare.minCandidate', passed: false }),
    );
    expect(methods(calls)).toContain('request');
  });

  test("the serving version comes from the scope's coordinates", async () => {
    const { app, calls, state } = setup();
    state.policy = policy(PASSING);
    state.resolved = { version: '1.1.0' as Semver, scope: PROJECT_SCOPE as LiveScope };
    state.testRun = testRun(summary());
    const scope = {
      kind: 'segment',
      projectId: PROJECT,
      path: [{ key: 'company', value: 'acme' }],
    };
    await app.request(`/v1/agents/${AGENT}/promotions`, promote({ scope }));
    expect(calls.find((c) => c.method === 'resolve')?.input).toEqual({
      tenantId,
      agentId: AGENT,
      projectId: PROJECT,
      segments: [{ key: 'company', value: 'acme' }],
    });
  });

  test("an org promotion looks up the org of the corrections' project", async () => {
    const { app, calls, state } = setup();
    const org = { kind: 'org', orgId: ORG };
    state.policy = policy(PASSING, org as LiveScope);
    state.testRun = testRun(summary());
    state.projectOrg = ORG;
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote({ scope: org }));
    expect(res.status).toBe(201);
    expect(calls.find((c) => c.method === 'projects.get')?.input).toBe(PROJECT);
  });

  test('an unknown test run → 404; one that is not a comparison → 400; nothing recorded', async () => {
    const missing = setup();
    missing.state.policy = policy(PASSING);
    const res404 = await missing.app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res404.status).toBe(404);
    expect(methods(missing.calls)).not.toContain('request');

    const accuracy = setup();
    accuracy.state.policy = policy(PASSING);
    accuracy.state.testRun = testRun(undefined, 'accuracy');
    const res400 = await accuracy.app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res400.status).toBe(400);
    expect(methods(accuracy.calls)).not.toContain('request');
  });

  test('an unregistered version → 404 before any gate', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(PASSING);
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote({ version: '1.3.0' }));
    expect(res.status).toBe(404);
    expect(methods(calls)).not.toContain('request');
  });

  test('the scope moved on while the gate ran → 409 promotion-superseded', async () => {
    const { app, state } = setup();
    state.policy = policy(PASSING);
    state.testRun = testRun(summary());
    state.requestError = { code: 'promotion-superseded', message: 'moved' };
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(409);
  });

  test("the gate wants an approval past the tenant's limit on approvals waiting → 429, naming it", async () => {
    const { app, state } = setup();
    state.policy = policy({ ...PASSING, approvals: {} });
    state.testRun = testRun(summary());
    state.requestError = {
      code: 'approvals-pending-limit',
      message: "This tenant's limit on approvals waiting for a decision (5) is reached.",
    };
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'approvals-pending-limit',
    );
  });
});

describe('POST /v1/agents/:agentId/promotions/check', () => {
  test.each([
    ['would-promote', PASSING],
    ['needs-approval', { ...PASSING, approvals: {} }],
    ['gate-failed', FAILING],
  ] as const)('%s, recording nothing', async (outcome, spec) => {
    const { app, calls, state } = setup();
    state.policy = policy(spec);
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/promotions/check`, promote());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcome).toBe(outcome);
    expect(body.policy).toEqual({ id: 'acme.drafting-prod', version: '1.0.0' });
    expect(Array.isArray(body.checks)).toBe(true);
    if (outcome === 'needs-approval') {
      expect(body.approval).toEqual({ role: 'senior', count: 1, separateApprover: true });
    }
    expect(methods(calls)).not.toContain('request');
    expect(methods(calls)).not.toContain('promote');
  });

  test('no policy: would-promote, policy null', async () => {
    const { app } = setup();
    const res = await app.request(`/v1/agents/${AGENT}/promotions/check`, promote());
    expect(await res.json()).toEqual({ outcome: 'would-promote', policy: null, checks: [] });
  });
});

describe('GET /v1/agents/:agentId/gate-policy', () => {
  test('the policy for a scope, with the scope as the gate resolves it', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(PASSING);
    const res = await app.request(
      `/v1/agents/${AGENT}/gate-policy?scopeKind=project&scopeId=${PROJECT}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      policy: { id: 'acme.drafting-prod', version: '1.0.0', agentId: AGENT, scope: PROJECT_SCOPE },
    });
    expect(calls.find((c) => c.method === 'policy.resolve')?.input).toEqual({
      tenantId,
      agentId: AGENT,
      scope: PROJECT_SCOPE,
    });
  });

  test('none → policy null; no gate policies at all → policy null', async () => {
    const none = setup();
    const res = await none.app.request(`/v1/agents/${AGENT}/gate-policy?scopeKind=tenant`, {
      headers: auth,
    });
    expect(await res.json()).toEqual({ policy: null });
    const ungated = setup({ gatePolicies: false });
    const res2 = await ungated.app.request(`/v1/agents/${AGENT}/gate-policy?scopeKind=tenant`, {
      headers: auth,
    });
    expect(await res2.json()).toEqual({ policy: null });
  });

  test('without a scope → 400', async () => {
    const { app } = setup();
    const res = await app.request(`/v1/agents/${AGENT}/gate-policy`, { headers: auth });
    expect(res.status).toBe(400);
  });
});

describe('a pin in place (T288): the scope has no pin of its own and serves the version already', () => {
  const STRICT: GatePolicySpec = {
    ...FAILING,
    approvals: { role: 'senior', separateApprover: true },
  };
  const pinHere = post({ version: '1.1.0', scope: PROJECT_SCOPE });

  test("skips the gate's checks and approval: one passing pinInPlace check, the binding re-checks → 201", async () => {
    const { app, calls, state } = setup();
    state.policy = policy(STRICT);
    // Nothing pinned: the scope serves the latest, 1.1.0.
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, pinHere);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Promotion;
    expect(body.status).toBe('promoted');
    expect(body.checks).toEqual([
      expect.objectContaining({
        name: 'pinInPlace',
        passed: true,
        message: expect.stringContaining('changes nothing for runs'),
      }),
    ]);
    const requested = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(requested.gate).toMatchObject({
      policy: { id: 'acme.drafting-prod', version: '1.0.0' },
      passed: true,
      servingVersion: '1.1.0',
      pinInPlace: true,
    });
    expect(requested.gate.approval).toBeUndefined();
    expect(methods(calls)).not.toContain('testRuns.get');
  });

  test('serving it from a pin above counts too', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(STRICT);
    state.resolved = { version: '1.2.0' as Semver, scope: { kind: 'tenant' } };
    const res = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      post({ version: '1.2.0', scope: PROJECT_SCOPE }),
    );
    expect(res.status).toBe(201);
    const requested = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(requested.gate.pinInPlace).toBe(true);
    expect(requested.gate.checks[0]?.message).toContain('from a pin above it');
  });

  test('a scope with a pin of its own runs the gate, even for the version it serves', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(STRICT);
    state.resolved = { version: '1.1.0' as Semver, scope: PROJECT_SCOPE as LiveScope };
    state.pins = [
      {
        agentId: AGENT,
        scope: PROJECT_SCOPE as LiveScope,
        version: '1.1.0' as Semver,
        promotionId: 'p-0',
        setAt: NOW.toISOString() as Timestamp,
      },
    ];
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, pinHere);
    // The policy wants a comparison, and none was named.
    expect(res.status).toBe(422);
    const requested = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(requested.gate.passed).toBe(false);
    expect(requested.gate.pinInPlace).toBeUndefined();
  });

  test('…/check answers the same, recording nothing', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(STRICT);
    const res = await app.request(`/v1/agents/${AGENT}/promotions/check`, pinHere);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outcome: 'would-promote',
      checks: [{ name: 'pinInPlace', passed: true }],
    });
    expect(methods(calls)).not.toContain('request');
  });

  test('the scope moved before the write: the binding refuses → 409 promotion-superseded', async () => {
    const { app, state } = setup();
    state.policy = policy(STRICT);
    state.requestError = {
      code: 'promotion-superseded',
      message: 'acme.drafting 1.2.0 serves this scope now, not 1.1.0: check again',
    };
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, pinHere);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('promotion-superseded');
  });
});

describe('what the scope runs: its Latest, not the highest version (1.1.0)', () => {
  const STRICT: GatePolicySpec = {
    ...FAILING,
    approvals: { role: 'senior', separateApprover: true },
  };
  const LATEST: LatestAnswer = { version: '1.0.0' as Semver, deploymentId: 'dep-1' };

  test('the gate measures the version against the Latest', async () => {
    const { app, calls, state } = setup();
    state.latest = LATEST;
    const res = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      promote({ evalRunId: undefined }),
    );
    expect(res.status).toBe(201);
    const request = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(request.gate.servingVersion).toBe('1.0.0');
  });

  test('pinning the Latest is a pin in place; pinning the highest runs the gate', async () => {
    const { app, calls, state } = setup();
    state.policy = policy(STRICT);
    state.latest = LATEST;
    const here = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      post({ version: '1.0.0', scope: PROJECT_SCOPE }),
    );
    expect(here.status).toBe(201);
    const requested = calls.find((c) => c.method === 'request')?.input as PromotionRequestInput;
    expect(requested.gate).toMatchObject({ servingVersion: '1.0.0', pinInPlace: true });
    expect(requested.gate.checks[0]?.message).toContain('as its Latest');

    // The policy wants a comparison, and none was named.
    const highest = await app.request(
      `/v1/agents/${AGENT}/promotions`,
      post({ version: '1.1.0', scope: PROJECT_SCOPE }),
    );
    expect(highest.status).toBe(422);
  });

  test('nothing runs in the scope (no pin, no Latest): 409 nothing-runs-in-scope, nothing recorded', async () => {
    const { app, calls, state } = setup();
    state.latest = null;
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('nothing-runs-in-scope');
    expect(error.message).toContain(
      'Deploy or publish a version into the project first; into a later environment, promote a build that ships one',
    );
    expect(methods(calls)).not.toContain('request');

    const check = await app.request(`/v1/agents/${AGENT}/promotions/check`, promote());
    expect(check.status).toBe(409);
    expect(JSON.stringify(await check.json())).toContain('nothing-runs-in-scope');
  });

  test("nothing runs because the scope's project is suspended: 409 project-suspended", async () => {
    const { app, calls, state } = setup();
    state.latest = null;
    state.suspended = true;
    const res = await app.request(`/v1/agents/${AGENT}/promotions`, promote());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('project-suspended');
    expect(calls.find((c) => c.method === 'projectSuspended')?.input).toBe(PROJECT);
    expect(methods(calls)).not.toContain('request');
  });
});
