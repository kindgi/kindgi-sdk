// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Pins through their gate: the route resolves the
 * scope's release gate, runs the gate on the named comparison and has the
 * binding record the outcome (201 pinned, 202 waiting for approval, 422
 * gate-failed). `…/pinned/check` answers the same, recording nothing.
 * The bindings are fakes that record their inputs.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AgentPinScope, ProjectId, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinResolution,
  AgentPinnedVersion,
  AgentRegistryBinding,
  CorrectedComparisonSummary,
  CorrectionListInput,
  LatestAnswer,
  Pin,
  PinError,
  PinFilesWarnings,
  PinRequestInput,
  ReleaseGate,
  ReleaseGateSpec,
  RunHandlerBinding,
  TestRun,
  TestRunBinding,
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
    metrics: { passRate: m, caseCoverage: m, weightedPrecisionAtK: { ...m, k: 10 } },
    ...overrides,
  };
}

function releaseGate(
  spec: ReleaseGateSpec,
  scope: AgentPinScope = PROJECT_SCOPE as AgentPinScope,
): ReleaseGate {
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

const PASSING: ReleaseGateSpec = { metrics: [{ name: 'passRate', minCandidate: 0.75 }] };
const FAILING: ReleaseGateSpec = { metrics: [{ name: 'passRate', minCandidate: 0.9 }] };

/**
 * `fixed`: a correction registry whose `fixed` corrections of the agent are
 * these. Absent: none is wired.
 */
function setup(
  opts: {
    request?: boolean;
    releaseGates?: boolean;
    fixed?: readonly string[];
    pinFiles?: PinFilesWarnings;
  } = {},
) {
  const calls: { method: string; input: unknown }[] = [];
  const state: {
    resolved: AgentPinResolution | null;
    releaseGate: ReleaseGate | null;
    testRun: TestRun | null;
    requestError: PinError | null;
    projectOrg: string | undefined;
    pins: AgentPinnedVersion[];
    /** Latest in every scope, `null` for none; absent: the highest version. */
    latest?: LatestAnswer | null;
    suspended: boolean;
  } = {
    resolved: null,
    releaseGate: null,
    testRun: null,
    requestError: null,
    projectOrg: undefined,
    pins: [],
    suspended: false,
  };
  const record = (method: string, input: unknown) => calls.push({ method, input });
  const pinOf = (input: PinRequestInput): Pin => ({
    id: 'promo-1',
    agentId: input.agentId,
    scope: input.scope,
    action: 'pin',
    fromVersion: null,
    toVersion: input.version,
    requestedBy: input.requestedBy,
    createdAt: NOW.toISOString() as Timestamp,
    status: !input.gate.passed
      ? 'refused'
      : input.gate.approval !== undefined
        ? 'pending-approval'
        : 'pinned',
    releaseGate: input.gate.releaseGate,
    checks: input.gate.checks,
    ...(input.gate.passed && input.gate.approval !== undefined && { approvalId: 'appr-1' }),
    ...(input.stoppedFollowingLatest !== undefined && {
      stoppedFollowingLatest: input.stoppedFollowingLatest,
    }),
  });
  const pins: AgentPinBindings = {
    pinned: {
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
    changes: {
      pin: async (input) => {
        record('pin', input);
        return {
          kind: 'ok',
          value: {
            id: 'promo-0',
            agentId: input.agentId,
            scope: input.scope,
            action: 'pin',
            fromVersion: null,
            toVersion: input.version,
            requestedBy: input.requestedBy,
            createdAt: NOW.toISOString() as Timestamp,
          },
        };
      },
      ...(opts.request !== false && {
        request: async (input: PinRequestInput) => {
          record('request', input);
          if (state.requestError !== null) return { kind: 'err', error: state.requestError };
          return { kind: 'ok', value: pinOf(input) };
        },
      }),
      unpin: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'unused' } }),
      list: async () => ({ data: [] }),
      get: async () => null,
    },
    ...(opts.releaseGates !== false && {
      releaseGates: {
        resolve: async (input: unknown) => {
          record('releaseGate.resolve', input);
          return state.releaseGate;
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
    agentPins: pins,
    testRunBinding: testRuns,
    ...(opts.fixed !== undefined && {
      correctionRegistry: {
        list: async (input: CorrectionListInput) => {
          record('corrections.list', input);
          const fixed = input.statuses?.length === 1 && input.statuses[0] === 'fixed';
          return {
            data: fixed ? (opts.fixed ?? []).map((id) => ({ id, status: 'fixed' })) : [],
            hasMore: false,
          };
        },
      } as never,
    }),
    projectSuspended: async (_t: TenantId, projectId: ProjectId) => {
      record('projectSuspended', projectId);
      return state.suspended;
    },
    ...(opts.pinFiles !== undefined && { pinFiles: opts.pinFiles }),
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

const testRun = (
  s: CorrectedComparisonSummary | undefined,
  kind = 'corrections',
  status: TestRun['status'] = 'completed',
): TestRun =>
  ({
    id: 'eval-1',
    testRunId: 'eval-1',
    kind,
    status,
    ...(s !== undefined && { result: { summary: s, perCase: [] } }),
  }) as never;

// The project follows Latest unless a test pins it (`state.resolved`): these
// pins ask to take it off (`stopFollowingLatest`), so the gate is what decides.
const pinBody = (body: Record<string, unknown> = {}) =>
  post({
    version: '1.2.0',
    scope: PROJECT_SCOPE,
    testRunId: 'eval-1',
    stopFollowingLatest: true,
    ...body,
  });

const methods = (calls: { method: string }[]) => calls.map((c) => c.method);

describe('POST /v1/agents/:agentId/pinned/pin, through the gate', () => {
  test('no release gate: recorded as pinned, releaseGate null, no checks → 201', async () => {
    const { app, calls } = setup();
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      pinBody({ testRunId: undefined }),
    );
    expect(res.status).toBe(201);
    // No test runs wired here: the pin, and no runs that check it.
    expect(await res.json()).toEqual({
      pin: expect.objectContaining({ status: 'pinned', releaseGate: null, checks: [] }),
      testRuns: [],
      fixed: [],
      reopened: [],
    });
    const request = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(request.gate).toEqual({
      releaseGate: null,
      checks: [],
      passed: true,
      servingVersion: '1.1.0',
    });
  });

  test('no release gate, a binding from before gates (no request): pinned as before', async () => {
    const { app, calls } = setup({ request: false });
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      pinBody({ testRunId: undefined }),
    );
    expect(res.status).toBe(201);
    // What runs in the project first (it follows Latest), then the gate's lookup.
    expect(methods(calls)).toEqual(['resolve', 'releaseGate.resolve', 'pin']);
  });

  test("a release gate applies, and the binding can't record a gated pin → 501, nothing pinned", async () => {
    const { app, calls, state } = setup({ request: false });
    state.releaseGate = releaseGate(PASSING);
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'pin-gate-unsupported',
    );
    expect(methods(calls)).not.toContain('pin');
  });

  test('the gate passes: 201 pinned, with the release gate and its checks', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(PASSING);
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(201);
    const body = ((await res.json()) as { pin: Record<string, unknown> }).pin;
    expect(body).toMatchObject({
      status: 'pinned',
      releaseGate: { id: 'acme.drafting-prod', version: '1.0.0' },
    });
    expect((body.checks as { passed: boolean }[]).every((c) => c.passed)).toBe(true);
    const request = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(request.gate).toMatchObject({ passed: true, servingVersion: '1.1.0' });
    expect(request.testRunId).toBe('eval-1');
  });

  test('the gate passes and wants an approval: 202, with the approval id', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate({ ...PASSING, approvals: { role: 'admin' } });
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      pin: { status: 'pending-approval', approvalId: 'appr-1' },
    });
    const request = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(request.gate.approval).toEqual({ role: 'admin', count: 1, separateApprover: true });
  });

  test('the gate fails: 422 gate-failed, the refusal recorded, every check in the details', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(FAILING);
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(error.code).toBe('gate-failed');
    expect(error.message).toContain(
      'The weighted share marked right is 0.8; the gate needs at least 0.9.',
    );
    expect(error.details).toMatchObject({
      changeId: 'promo-1',
      releaseGate: { id: 'acme.drafting-prod', version: '1.0.0' },
    });
    expect(error.details.checks).toContainEqual(
      expect.objectContaining({ name: 'metric.passRate.minCandidate', passed: false }),
    );
    expect(methods(calls)).toContain('request');
  });

  test("the cases rule: the 422's details carry passing, needs, and the cases that passed before and fail now", async () => {
    const { app, calls, state } = setup({ fixed: ['c-1', 'c-2'] });
    state.releaseGate = releaseGate({ cases: { minPassing: 3, noNewFailures: true } });
    state.testRun = testRun(
      summary({
        corrections: {
          checked: 3,
          passed: 1,
          results: [
            { correctionId: 'c-1', pass: true },
            { correctionId: 'c-2', pass: false },
            { correctionId: 'c-3', pass: false },
          ],
        },
      }),
    );
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(error.code).toBe('gate-failed');
    expect(error.details).toMatchObject({ passing: 1, needs: 3, newlyFailing: ['c-2'] });
    expect(error.message).toContain('1 case that passed before fails now: c-2.');
    expect(calls.find((c) => c.method === 'corrections.list')?.input).toMatchObject({
      tenantId,
      scope: { kind: 'project', projectId: PROJECT },
      agentId: AGENT,
      statuses: ['fixed'],
    });
  });

  test('without noNewFailures the gate reads no corrections, and the details have no newlyFailing', async () => {
    const { app, calls, state } = setup({ fixed: ['c-1'] });
    state.releaseGate = releaseGate({ cases: { minPassing: 1 } });
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(error.details).toMatchObject({ passing: 0, needs: 1 });
    expect(error.details).not.toHaveProperty('newlyFailing');
    expect(methods(calls)).not.toContain('corrections.list');
  });

  test("the serving version comes from the scope's coordinates", async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(PASSING);
    state.resolved = { version: '1.1.0' as Semver, scope: PROJECT_SCOPE as AgentPinScope };
    state.testRun = testRun(summary());
    const scope = {
      kind: 'segment',
      projectId: PROJECT,
      path: [{ key: 'company', value: 'acme' }],
    };
    await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody({ scope }));
    expect(calls.find((c) => c.method === 'resolve')?.input).toEqual({
      tenantId,
      agentId: AGENT,
      projectId: PROJECT,
      segments: [{ key: 'company', value: 'acme' }],
    });
  });

  test("an org pin looks up the org of the corrections' project", async () => {
    const { app, calls, state } = setup();
    const org = { kind: 'org', orgId: ORG };
    state.releaseGate = releaseGate(PASSING, org as AgentPinScope);
    state.testRun = testRun(summary());
    state.projectOrg = ORG;
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody({ scope: org }));
    expect(res.status).toBe(201);
    expect(calls.find((c) => c.method === 'projects.get')?.input).toBe(PROJECT);
  });

  test('an unknown test run → 404; one that is not a comparison → 400; nothing recorded', async () => {
    const missing = setup();
    missing.state.releaseGate = releaseGate(PASSING);
    const res404 = await missing.app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res404.status).toBe(404);
    expect(methods(missing.calls)).not.toContain('request');

    const accuracy = setup();
    accuracy.state.releaseGate = releaseGate(PASSING);
    accuracy.state.testRun = testRun(undefined, 'accuracy');
    const res400 = await accuracy.app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res400.status).toBe(400);
    expect(methods(accuracy.calls)).not.toContain('request');
  });

  // A comparison cancelled or failed part way can keep the summary of the
  // cases it got through. These figures pass the gate, so it's the run's
  // status that refuses it.
  test.each(['cancelled', 'failed'] as const)(
    "a comparison that's %s → 400 bad-input, though its summary would pass; nothing recorded",
    async (status) => {
      const { app, calls, state } = setup();
      state.releaseGate = releaseGate(PASSING);
      state.testRun = testRun(summary({ cases: 12 }), 'corrections', status);
      const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      expect(error).toMatchObject({
        code: 'bad-input',
        message: `Test run eval-1 isn't a completed comparison: it's ${status}. Name a run that completed.`,
      });
      expect(methods(calls)).not.toContain('request');
      expect(methods(calls)).not.toContain('pin');
    },
  );

  test.each([
    [201, PASSING],
    [422, FAILING],
  ] as const)(
    'the same summary on a completed run goes through the gate: %d',
    async (code, spec) => {
      const { app, calls, state } = setup();
      state.releaseGate = releaseGate(spec);
      state.testRun = testRun(summary({ cases: 12 }), 'corrections', 'completed');
      const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
      expect(res.status).toBe(code);
      const request = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
      expect(request.gate.passed).toBe(code === 201);
    },
  );

  test('an unregistered version → 404 before any gate', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(PASSING);
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody({ version: '1.3.0' }));
    expect(res.status).toBe(404);
    expect(methods(calls)).not.toContain('request');
  });

  test('the scope moved on while the gate ran → 409 pin-superseded', async () => {
    const { app, state } = setup();
    state.releaseGate = releaseGate(PASSING);
    state.testRun = testRun(summary());
    state.requestError = { code: 'pin-superseded', message: 'moved' };
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(409);
  });

  test("the gate wants an approval past the tenant's limit on approvals waiting → 429, naming it", async () => {
    const { app, state } = setup();
    state.releaseGate = releaseGate({ ...PASSING, approvals: {} });
    state.testRun = testRun(summary());
    state.requestError = {
      code: 'approvals-pending-limit',
      message: "This workspace's limit on approvals waiting for a decision (5) is reached.",
    };
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'approvals-pending-limit',
    );
  });
});

describe('a pin that would take a project off Latest (pin-stops-latest)', () => {
  test('refused with 409 before any gate, naming what the project runs; nothing recorded', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(FAILING);
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.2.0', scope: PROJECT_SCOPE, testRunId: 'eval-1' }),
    );
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: unknown };
    };
    expect(error.code).toBe('pin-stops-latest');
    expect(error.details).toEqual({ projects: [{ projectId: PROJECT, version: '1.1.0' }] });
    expect(error.message).toContain('stopFollowingLatest');
    expect(methods(calls)).toEqual(['resolve']);
  });

  test.each([
    ['not registered', '9.9.9'],
    ['unregistered', '1.3.0'],
  ])(
    'a version that is %s is a 404 first, not the 409; nothing recorded',
    async (_name, version) => {
      const { app, calls } = setup();
      const res = await app.request(
        `/v1/agents/${AGENT}/pinned/pin`,
        post({ version, scope: PROJECT_SCOPE }),
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'agent-version-not-found',
      );
      // Only what the project runs is read: nothing is recorded.
      expect(methods(calls)).toEqual(['resolve']);
    },
  );

  test('pinning the version it runs already takes it off Latest too: the same 409', async () => {
    const { app, calls } = setup();
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.1.0', scope: PROJECT_SCOPE }),
    );
    expect(res.status).toBe(409);
    expect(methods(calls)).not.toContain('request');
  });

  test('stopFollowingLatest: true pins it, and the change records stoppedFollowingLatest', async () => {
    const { app, calls } = setup();
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      pinBody({ testRunId: undefined }),
    );
    expect(res.status).toBe(201);
    const requested = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(requested.stoppedFollowingLatest).toBe(true);
    expect(((await res.json()) as { pin: Pin }).pin.stoppedFollowingLatest).toBe(true);
  });

  test('a project a pin covers already: no 409, and nothing recorded about Latest', async () => {
    const { app, calls, state } = setup();
    state.resolved = { version: '1.1.0' as Semver, scope: { kind: 'tenant' } };
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.2.0', scope: PROJECT_SCOPE }),
    );
    expect(res.status).toBe(201);
    const requested = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(requested).not.toHaveProperty('stoppedFollowingLatest');
  });

  test('a stopFollowingLatest that is not a boolean → 400, nothing recorded', async () => {
    const { app, calls } = setup();
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      pinBody({ stopFollowingLatest: 'yes' }),
    );
    expect(res.status).toBe(400);
    expect(methods(calls)).toEqual([]);
  });

  test('a check ignores it: what the gate would say, with or without the flag', async () => {
    const { app } = setup();
    for (const stopFollowingLatest of [undefined, true]) {
      const res = await app.request(
        `/v1/agents/${AGENT}/pinned/check`,
        post({ version: '1.2.0', scope: PROJECT_SCOPE, stopFollowingLatest }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe('would-pin');
    }
  });
});

describe('POST /v1/agents/:agentId/pinned/check', () => {
  test.each([
    ['would-pin', PASSING],
    ['needs-approval', { ...PASSING, approvals: {} }],
    ['gate-failed', FAILING],
  ] as const)('%s, recording nothing', async (outcome, spec) => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(spec);
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcome).toBe(outcome);
    expect(body.releaseGate).toEqual({ id: 'acme.drafting-prod', version: '1.0.0' });
    expect(Array.isArray(body.checks)).toBe(true);
    if (outcome === 'needs-approval') {
      expect(body.approval).toEqual({ role: 'senior', count: 1, separateApprover: true });
    }
    expect(methods(calls)).not.toContain('request');
    expect(methods(calls)).not.toContain('pin');
  });

  test("a comparison that's cancelled → 400 bad-input, as the pin answers", async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(PASSING);
    state.testRun = testRun(summary({ cases: 12 }), 'corrections', 'cancelled');
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    expect(methods(calls)).not.toContain('request');
  });

  test('no release gate: would-pin, releaseGate null', async () => {
    const { app } = setup();
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(await res.json()).toEqual({ outcome: 'would-pin', releaseGate: null, checks: [] });
  });
});

describe("POST /v1/agents/:agentId/pinned/check: under kindgi dev, the files git hasn't committed", () => {
  /** A `pinFiles` that answers `warning` and records what it was asked. */
  const reading = (warning: Awaited<ReturnType<PinFilesWarnings>>) => {
    const asked: Parameters<PinFilesWarnings>[0][] = [];
    const pinFiles: PinFilesWarnings = async (q) => {
      asked.push(q);
      return warning;
    };
    return { asked, pinFiles };
  };

  test('the files the pin would write over, read for the version asked', async () => {
    const { asked, pinFiles } = reading({
      uncommittedFiles: ['blocks/reply.liquid', 'blocks/tone.json'],
    });
    const { app } = setup({ pinFiles });
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: 'would-pin',
      releaseGate: null,
      checks: [],
      uncommittedFiles: ['blocks/reply.liquid', 'blocks/tone.json'],
    });
    expect(asked).toEqual([{ tenantId: expect.any(String), agentId: AGENT, version: '1.2.0' }]);
  });

  test("the pack isn't in git", async () => {
    const { app } = setup({ pinFiles: reading({ notInGit: true }).pinFiles });
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(await res.json()).toMatchObject({ outcome: 'would-pin', notInGit: true });
  });

  test('a pin waiting for an approval is warned too: the approval writes the files', async () => {
    const { app, state } = setup({ pinFiles: reading({ notInGit: true }).pinFiles });
    state.releaseGate = releaseGate({ ...PASSING, approvals: {} });
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(await res.json()).toMatchObject({ outcome: 'needs-approval', notInGit: true });
  });

  test.each([
    ['nothing to warn about', undefined],
    ['no file listed', { uncommittedFiles: [] }],
  ] as const)('%s: neither field', async (_, warning) => {
    const { app } = setup({ pinFiles: reading(warning).pinFiles });
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(await res.json()).toEqual({ outcome: 'would-pin', releaseGate: null, checks: [] });
  });

  test("a gate that fails: the pin doesn't go, so nothing is read", async () => {
    const { asked, pinFiles } = reading({ uncommittedFiles: ['blocks/tone.json'] });
    const { app, state } = setup({ pinFiles });
    state.releaseGate = releaseGate(FAILING);
    state.testRun = testRun(summary());
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcome).toBe('gate-failed');
    expect(body).not.toHaveProperty('uncommittedFiles');
    expect(asked).toEqual([]);
  });
});

describe('GET /v1/agents/:agentId/release-gate', () => {
  test('the release gate for a scope, with the scope as the gate resolves it', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(PASSING);
    const res = await app.request(
      `/v1/agents/${AGENT}/release-gate?scopeKind=project&scopeId=${PROJECT}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      releaseGate: {
        id: 'acme.drafting-prod',
        version: '1.0.0',
        agentId: AGENT,
        scope: PROJECT_SCOPE,
      },
    });
    expect(calls.find((c) => c.method === 'releaseGate.resolve')?.input).toEqual({
      tenantId,
      agentId: AGENT,
      scope: PROJECT_SCOPE,
    });
  });

  test('none → releaseGate null; no release gates at all → releaseGate null', async () => {
    const none = setup();
    const res = await none.app.request(`/v1/agents/${AGENT}/release-gate?scopeKind=tenant`, {
      headers: auth,
    });
    expect(await res.json()).toEqual({ releaseGate: null });
    const ungated = setup({ releaseGates: false });
    const res2 = await ungated.app.request(`/v1/agents/${AGENT}/release-gate?scopeKind=tenant`, {
      headers: auth,
    });
    expect(await res2.json()).toEqual({ releaseGate: null });
  });

  test('without a scope → 400', async () => {
    const { app } = setup();
    const res = await app.request(`/v1/agents/${AGENT}/release-gate`, { headers: auth });
    expect(res.status).toBe(400);
  });
});

describe('a pin in place (T288): the scope has no pin of its own and serves the version already', () => {
  const STRICT: ReleaseGateSpec = {
    ...FAILING,
    approvals: { role: 'senior', separateApprover: true },
  };
  const pinHere = post({ version: '1.1.0', scope: PROJECT_SCOPE, stopFollowingLatest: true });

  test("skips the gate's checks and approval: one passing pinInPlace check, the binding re-checks → 201", async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(STRICT);
    // Nothing pinned: the scope serves the latest, 1.1.0.
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinHere);
    expect(res.status).toBe(201);
    const body = ((await res.json()) as { pin: Pin }).pin;
    expect(body.status).toBe('pinned');
    expect(body.checks).toEqual([
      expect.objectContaining({
        name: 'pinInPlace',
        passed: true,
        message: expect.stringContaining('changes nothing for runs'),
      }),
    ]);
    const requested = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(requested.gate).toMatchObject({
      releaseGate: { id: 'acme.drafting-prod', version: '1.0.0' },
      passed: true,
      servingVersion: '1.1.0',
      pinInPlace: true,
    });
    expect(requested.gate.approval).toBeUndefined();
    expect(methods(calls)).not.toContain('testRuns.get');
  });

  test('serving it from a pin above counts too', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(STRICT);
    state.resolved = { version: '1.2.0' as Semver, scope: { kind: 'tenant' } };
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.2.0', scope: PROJECT_SCOPE }),
    );
    expect(res.status).toBe(201);
    const requested = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(requested.gate.pinInPlace).toBe(true);
    expect(requested.gate.checks[0]?.message).toContain('from a pin above it');
  });

  test('a scope with a pin of its own runs the gate, even for the version it serves', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(STRICT);
    state.resolved = { version: '1.1.0' as Semver, scope: PROJECT_SCOPE as AgentPinScope };
    state.pins = [
      {
        agentId: AGENT,
        scope: PROJECT_SCOPE as AgentPinScope,
        version: '1.1.0' as Semver,
        changeId: 'p-0',
        setAt: NOW.toISOString() as Timestamp,
      },
    ];
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinHere);
    // The gate wants a comparison, and none was named.
    expect(res.status).toBe(422);
    const requested = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(requested.gate.passed).toBe(false);
    expect(requested.gate.pinInPlace).toBeUndefined();
  });

  test('…/check answers the same, recording nothing', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(STRICT);
    const res = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinHere);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outcome: 'would-pin',
      checks: [{ name: 'pinInPlace', passed: true }],
    });
    expect(methods(calls)).not.toContain('request');
  });

  test('the scope moved before the write: the binding refuses → 409 pin-superseded', async () => {
    const { app, state } = setup();
    state.releaseGate = releaseGate(STRICT);
    state.requestError = {
      code: 'pin-superseded',
      message: 'acme.drafting 1.2.0 serves this scope now, not 1.1.0: check again',
    };
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinHere);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('pin-superseded');
  });
});

describe('what the scope runs: its Latest, not the highest version (1.1.0)', () => {
  const STRICT: ReleaseGateSpec = {
    ...FAILING,
    approvals: { role: 'senior', separateApprover: true },
  };
  const LATEST: LatestAnswer = { version: '1.0.0' as Semver, deploymentId: 'dep-1' };

  test('the gate measures the version against the Latest', async () => {
    const { app, calls, state } = setup();
    state.latest = LATEST;
    const res = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      pinBody({ testRunId: undefined }),
    );
    expect(res.status).toBe(201);
    const request = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(request.gate.servingVersion).toBe('1.0.0');
  });

  test('pinning the Latest is a pin in place; pinning the highest runs the gate', async () => {
    const { app, calls, state } = setup();
    state.releaseGate = releaseGate(STRICT);
    state.latest = LATEST;
    const here = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.0.0', scope: PROJECT_SCOPE, stopFollowingLatest: true }),
    );
    expect(here.status).toBe(201);
    const requested = calls.find((c) => c.method === 'request')?.input as PinRequestInput;
    expect(requested.gate).toMatchObject({ servingVersion: '1.0.0', pinInPlace: true });
    expect(requested.gate.checks[0]?.message).toContain('as its Latest');

    // The release gate wants a test run, and none was named.
    const highest = await app.request(
      `/v1/agents/${AGENT}/pinned/pin`,
      post({ version: '1.1.0', scope: PROJECT_SCOPE, stopFollowingLatest: true }),
    );
    expect(highest.status).toBe(422);
  });

  test('nothing runs in the scope (no pin, no Latest): 409 nothing-runs-in-scope, nothing recorded', async () => {
    const { app, calls, state } = setup();
    state.latest = null;
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('nothing-runs-in-scope');
    expect(error.message).toContain(
      'Deploy or publish a version into the project first; into a later environment, promote a build that ships one',
    );
    expect(methods(calls)).not.toContain('request');

    const check = await app.request(`/v1/agents/${AGENT}/pinned/check`, pinBody());
    expect(check.status).toBe(409);
    expect(JSON.stringify(await check.json())).toContain('nothing-runs-in-scope');
  });

  test("nothing runs because the scope's project is suspended: 409 project-suspended", async () => {
    const { app, calls, state } = setup();
    state.latest = null;
    state.suspended = true;
    const res = await app.request(`/v1/agents/${AGENT}/pinned/pin`, pinBody());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('project-suspended');
    expect(calls.find((c) => c.method === 'projectSuspended')?.input).toBe(PROJECT);
    expect(methods(calls)).not.toContain('request');
  });
});
