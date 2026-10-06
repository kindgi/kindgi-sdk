// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/gate-policies` (evals step 4b): the registry routes over a fake
 * binding, the strict spec check, and `admin` on the tenant for writes.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { createStubAppBindings } from '@kindgi/testing';
import type { LiveScope, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  AgentReleaseBindings,
  GatePolicy,
  GatePolicyBinding,
  GatePolicyError,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { gatePoliciesRouter } from '../src/routes/gate-policies.js';
import { parseGatePolicySpec } from '../src/routes/gate-policy-spec.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const TOKEN = 'gate-policies-token';
const PROJECT = randomUUID();
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
};
const auth = { authorization: `Bearer ${TOKEN}` };
const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

const SCOPE = { kind: 'project', projectId: PROJECT };
const BODY = {
  id: 'acme.drafting-prod',
  version: '1.0.0',
  agentId: 'acme.drafting',
  scope: SCOPE,
  spec: {
    comparison: { maxAgeHours: 168 },
    evidence: { minCases: 20 },
    metrics: [{ name: 'weightedPrecisionAtK', k: 5, minCandidate: 0.7, maxDrop: 0.02 }],
    replay: { maxRefusedWrites: 0 },
    approvals: { role: 'senior' },
  },
  description: 'Production gate',
};

function policy(version = '1.0.0'): GatePolicy {
  return {
    id: BODY.id,
    version,
    tenantId,
    agentId: BODY.agentId,
    scope: SCOPE as LiveScope,
    spec: BODY.spec as GatePolicy['spec'],
    description: BODY.description,
    createdAt: '2026-10-06T12:00:00.000Z' as Timestamp,
  };
}

function fakeBinding() {
  const calls: { method: string; input: unknown }[] = [];
  const state: { error: GatePolicyError | null; found: GatePolicy | null } = {
    error: null,
    found: policy(),
  };
  const result = (method: string, input: unknown) => {
    calls.push({ method, input });
    return state.error !== null
      ? { kind: 'err' as const, error: state.error }
      : { kind: 'ok' as const, value: policy() };
  };
  const binding: GatePolicyBinding = {
    publish: async (input) => result('publish', input),
    get: async (input) => {
      calls.push({ method: 'get', input });
      return state.found;
    },
    getVersion: async (input) => {
      calls.push({ method: 'getVersion', input });
      return state.found;
    },
    listVersions: async (input) => {
      calls.push({ method: 'listVersions', input });
      return state.found === null ? [] : [policy('1.0.0'), policy('1.1.0')];
    },
    list: async (input) => {
      calls.push({ method: 'list', input });
      return { data: [policy()] };
    },
    unregister: async (input) => result('unregister', input),
    reinstate: async (input) => result('reinstate', input),
    resolve: async () => null,
  };
  return { binding, calls, state };
}

function appWith(binding: GatePolicyBinding) {
  const releases: AgentReleaseBindings = {
    live: { resolve: async () => null, list: async () => [] },
    promotions: {
      promote: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'unused' } }),
      rollback: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'unused' } }),
      unpin: async () => ({ kind: 'err', error: { code: 'not-pinned', message: 'unused' } }),
      list: async () => ({ data: [] }),
      get: async () => null,
    },
    gatePolicies: binding,
  };
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    agentReleases: releases,
  });
}

describe('POST /v1/gate-policies', () => {
  test('publishes → 201, the policy on the wire', async () => {
    const { binding, calls } = fakeBinding();
    const res = await appWith(binding).request('/v1/gate-policies', post(BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ...BODY,
      createdAt: '2026-10-06T12:00:00.000Z',
    });
    expect(calls[0]).toEqual({ method: 'publish', input: { tenantId, ...BODY } });
  });

  test('an unknown spec key, a bad metric, a later feature → 400 validation-failed, every issue', async () => {
    const { binding, calls } = fakeBinding();
    const res = await appWith(binding).request(
      '/v1/gate-policies',
      post({
        ...BODY,
        spec: {
          metric: [],
          metrics: [
            { name: 'weightedYesShare' },
            { name: 'judgedCoverage', k: 5, minCandidate: 2 },
          ],
          approvals: { count: 2, forRollback: true },
        },
      }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as {
      error: { code: string; details: { issues: { path: string; message: string }[] } };
    };
    expect(error.code).toBe('validation-failed');
    const paths = error.details.issues.map((i) => i.path);
    expect(paths).toEqual([
      '/spec/metric',
      '/spec/metrics/0',
      '/spec/metrics/1/k',
      '/spec/metrics/1/minCandidate',
      '/spec/approvals/count',
      '/spec/approvals/forRollback',
    ]);
    expect(error.details.issues[4]?.message).toContain('one reviewer decides');
    expect(calls).toEqual([]);
  });

  test("the binding's 409s pass through, with who holds the scope", async () => {
    const { binding, state } = fakeBinding();
    state.error = {
      code: 'gate-policy-scope-taken',
      message: 'taken',
      heldBy: 'acme.other-gate',
    };
    const res = await appWith(binding).request('/v1/gate-policies', post(BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'gate-policy-scope-taken', details: { heldBy: 'acme.other-gate' } },
    });
  });
});

describe('reads', () => {
  test('GET / passes the agent and scope filters', async () => {
    const { binding, calls } = fakeBinding();
    const res = await appWith(binding).request(
      `/v1/gate-policies?agentId=acme.drafting&scopeKind=project&scopeId=${PROJECT}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ id: BODY.id }], hasMore: false });
    expect(calls[0]?.input).toMatchObject({ agentId: 'acme.drafting', scope: SCOPE });
  });

  test('GET /:id, /:id/versions, /:id/versions/:version; unknown → 404', async () => {
    const { binding, state } = fakeBinding();
    const app = appWith(binding);
    expect((await app.request(`/v1/gate-policies/${BODY.id}`, { headers: auth })).status).toBe(200);
    const versions = await app.request(`/v1/gate-policies/${BODY.id}/versions`, { headers: auth });
    expect(await versions.json()).toMatchObject({
      data: [{ version: '1.0.0' }, { version: '1.1.0' }],
    });
    expect(
      (await app.request(`/v1/gate-policies/${BODY.id}/versions/1.0.0`, { headers: auth })).status,
    ).toBe(200);
    state.found = null;
    for (const path of ['', '/versions', '/versions/9.9.9']) {
      const res = await app.request(`/v1/gate-policies/${BODY.id}${path}`, { headers: auth });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'gate-policy-not-found' } });
    }
  });

  test('unregister and reinstate a version', async () => {
    const { binding, calls } = fakeBinding();
    const app = appWith(binding);
    for (const action of ['unregister', 'reinstate']) {
      const res = await app.request(
        `/v1/gate-policies/${BODY.id}/versions/1.0.0/${action}`,
        post(),
      );
      expect(res.status).toBe(200);
    }
    expect(calls.map((c) => c.method)).toEqual(['unregister', 'reinstate']);
  });
});

describe('authorization: writes need admin on the tenant; reads none beyond the tenant', () => {
  function mounted(checked: string[]) {
    const authorizer: Authorizer = {
      authorize: (action, getResource) => async (c, next) => {
        const r = await getResource(c);
        checked.push(`${action} ${r.type}:${r.id}`);
        return next();
      },
      can: async () => false,
      check: async () => {
        throw new Error('unused');
      },
      filterByCan: async () => [],
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-gate' as never);
      return next();
    });
    app.route('/', gatePoliciesRouter(fakeBinding().binding, authorizer));
    return app;
  }

  test.each([
    ['POST', '/', BODY, [`admin tenant:${tenantId}`]],
    ['POST', `/${BODY.id}/versions/1.0.0/unregister`, undefined, [`admin tenant:${tenantId}`]],
    ['GET', '/', undefined, []],
    ['GET', `/${BODY.id}`, undefined, []],
  ] as const)('%s %s', async (method, path, body, expected) => {
    const checked: string[] = [];
    await mounted(checked).request(path, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    expect(checked).toEqual(expected);
  });
});

describe('parseGatePolicySpec', () => {
  test('an empty spec is valid: it checks nothing', () => {
    expect(parseGatePolicySpec({})).toEqual({ kind: 'ok', spec: {} });
  });

  test('a metric is gated once, with something to reach; k only for precision', () => {
    const r = parseGatePolicySpec({
      metrics: [
        { name: 'weightedPrecisionAtK', k: 5, minCandidate: 0.7 },
        { name: 'weightedPrecisionAtK', minCandidate: 0.6 },
        { name: 'judgedCoverage', maxDrop: 0 },
      ],
    });
    expect(r).toEqual({
      kind: 'err',
      issues: [{ path: '/spec/metrics/1/name', message: '`weightedPrecisionAtK` is gated twice' }],
    });
  });

  test('replay knobs are whole numbers; approvals take a reviewer role', () => {
    const r = parseGatePolicySpec({
      replay: { maxDiverged: 1.5 },
      approvals: { role: 'boss', separateApprover: 'yes' },
    });
    expect(r.kind === 'err' && r.issues.map((i) => i.path)).toEqual([
      '/spec/replay/maxDiverged',
      '/spec/approvals/role',
      '/spec/approvals/separateApprover',
    ]);
  });
});
