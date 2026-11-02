// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp, packServiceName } from '../src/index.js';
import type {
  DeploymentEndpoint,
  RunHandlerBinding,
  SetPackEndpointInput,
  SetPackEndpointOutcome,
  SystemAccessRecord,
  SystemDeploymentEntry,
  SystemDeploymentMissing,
  SystemDeploymentToRetire,
  SystemDeploymentToServe,
  SystemDeploymentsBinding,
  SystemTenantState,
} from '../src/index.js';

/**
 * The system routes behind per-deployment routing: whatever runs each
 * deployment's own pack service (an orchestrator, `system:deployments`)
 * lists what needs a service or should lose one, and records where each
 * runs; support suspends a pack (`system:suspend`). Checks 1 to 3 (the
 * URL, the allowlist, the service's name) are the route's, the rest the
 * binding's, and every refusal is on record as the endpoint's problem.
 */

const live = randomUUID() as TenantId;
const closing = randomUUID() as TenantId;
const suspended = randomUUID() as TenantId;
const STATES = new Map<string, SystemTenantState>([
  [live, 'active'],
  [closing, 'closing'],
  [suspended, 'suspended'],
]);

const ORCHESTRATOR = 'kgi_sy_orchestrator';
const SUPPORT = 'kgi_sy_support';
const TENANTS = 'kgi_sy_tenants';
const FULL = 'kgi_sy_full';
const TENANT_KEY = 'kgi_ak_tenant_with_operator_powers';
const SCOPES: Record<string, readonly string[]> = {
  [ORCHESTRATOR]: ['system:deployments'],
  [SUPPORT]: ['system:suspend'],
  [TENANTS]: ['system:tenants'],
  [FULL]: ['kindgi:system'],
};

/** The cell's pack hosts: one project's Cloud Run services. */
const RUN_TAIL = '-123456789012.us-central1.run.app';
const PACK_TOKEN = 'pack-token-0123456789abcdef';
const NOW = '2026-10-11T12:00:00.000Z';

function entry(tenantId: TenantId, deploymentId: string): SystemDeploymentEntry {
  return {
    tenantId,
    deploymentId,
    packId: 'acme.aperture',
    imageRef: `us-central1-docker.pkg.dev/acme-shard/s-1/pack@sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    artifactVersion: '20261011.1',
    activatedAt: NOW,
  };
}

/** Deployments in memory, with the binding's own checks programmable per deployment. */
function makeBinding() {
  const endpoints = new Map<string, DeploymentEndpoint>();
  const known = new Set<string>();
  const set: SetPackEndpointInput[] = [];
  const outcomes = new Map<string, SetPackEndpointOutcome>();
  const suspendedPacks = new Map<string, { suspended: boolean; since: string }>();
  const key = (t: string, d: string) => `${t}|${d}`;
  const add = (t: TenantId, d: string) => {
    known.add(key(t, d));
    endpoints.set(key(t, d), { status: 'pending', since: NOW });
  };
  const needing: SystemDeploymentMissing[] = [];
  const ready: SystemDeploymentToServe[] = [];
  const retiring: SystemDeploymentToRetire[] = [];
  const binding: SystemDeploymentsBinding = {
    async listNeedingEndpoint({ cursor, limit }) {
      if (cursor !== undefined && !/^\d+$/.test(cursor)) return { kind: 'cursor-unreadable' };
      const start = cursor === undefined ? 0 : Number(cursor);
      const data = needing.slice(start, start + limit);
      const next = start + limit < needing.length ? String(start + limit) : undefined;
      return { kind: 'ok', data, ...(next !== undefined && { nextCursor: next }) };
    },
    async listReady() {
      return { kind: 'ok', data: ready };
    },
    async listToRetire() {
      return { kind: 'ok', data: retiring };
    },
    async setEndpoint(input) {
      set.push(input);
      if (!known.has(key(input.tenantId, input.deploymentId))) return { kind: 'not-found' };
      const programmed = outcomes.get(input.deploymentId);
      if (programmed !== undefined) return programmed;
      const endpoint: DeploymentEndpoint = { status: 'ready', since: NOW };
      endpoints.set(key(input.tenantId, input.deploymentId), endpoint);
      return { kind: 'ok', endpoint };
    },
    async clearEndpoint({ tenantId, deploymentId }) {
      if (!known.has(key(tenantId, deploymentId))) return { kind: 'not-found' };
      const endpoint: DeploymentEndpoint = { status: 'cleared', since: NOW };
      endpoints.set(key(tenantId, deploymentId), endpoint);
      return { kind: 'ok', endpoint };
    },
    async recordProblem({ tenantId, deploymentId, code }) {
      const current = endpoints.get(key(tenantId, deploymentId));
      if (current === undefined) return { kind: 'not-found' };
      // As the runtime's: pending, or cleared and `waiting`.
      const waiting =
        current.status === 'pending' ||
        (current.status === 'cleared' &&
          needing.some((e) => e.tenantId === tenantId && e.deploymentId === deploymentId));
      if (!waiting) return { kind: 'not-pending', endpoint: current };
      const endpoint: DeploymentEndpoint = {
        ...current,
        problem: { code, since: NOW },
        ...(current.status === 'cleared' && { waiting: true }),
      };
      endpoints.set(key(tenantId, deploymentId), endpoint);
      return { kind: 'ok', endpoint };
    },
    async setSuspended({ tenantId, deploymentId, suspended: on }) {
      if (!known.has(key(tenantId, deploymentId))) return { kind: 'not-found' };
      const state = { suspended: on, since: NOW };
      suspendedPacks.set(key(tenantId, deploymentId), state);
      return { kind: 'ok', ...state };
    },
  };
  return { binding, add, endpoints, set, outcomes, needing, ready, retiring, suspendedPacks, key };
}

function makeApp(options: { readonly hostAllowed?: (host: string) => boolean } = {}) {
  const deployments = makeBinding();
  const audit: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
    runHandler: {} as RunHandlerBinding,
    resolveToken: async (token) => {
      const scopes = SCOPES[token];
      if (scopes !== undefined) {
        return { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: scopes };
      }
      if (token === TENANT_KEY) {
        return { tenantId: live, scopes: ['tenant-admin'], capabilities: ['kindgi:system'] };
      }
      return null;
    },
    systemAccessAudit: {
      async record(e) {
        audit.push(e);
      },
      async begin(attempt) {
        audit.push({ ...attempt, status: 0 });
        return String(audit.length - 1);
      },
      async finish(id, outcome) {
        audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
    // A runtime serving many tenants freezes a closing or suspended tenant's
    // writes; these routes are the system's, which the freeze doesn't touch.
    tenantStates: { of: async () => undefined },
    systemTenantDirectory: {
      async get(id) {
        const state = STATES.get(id);
        return state === undefined ? null : { id, state };
      },
    },
    systemDeployments: {
      binding: deployments.binding,
      endpointHostAllowed: options.hostAllowed ?? ((host) => host.endsWith(RUN_TAIL)),
    },
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    return { status: res.status, body: json, text };
  };
  return { call, deployments, audit };
}

const code = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code;
const details = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { details?: Record<string, unknown> } | undefined)?.details;

const endpointPath = (t: string, d: string) => `/v1/system/tenants/${t}/deployments/${d}/endpoint`;
const hostFor = (t: string, d: string) => `${packServiceName(t, d)}${RUN_TAIL}`;
const body = (url: string) => ({ url, auth: 'google-id-token', token: PACK_TOKEN });

describe('GET /v1/system/deployments', () => {
  test('missing: the entries, by page, with ids and the image only; a read across tenants on record', async () => {
    const { call, deployments, audit } = makeApp();
    deployments.needing.push(entry(live, 'dep-1'), entry(live, 'dep-2'), entry(live, 'dep-3'));
    const first = await call(
      ORCHESTRATOR,
      'GET',
      '/v1/system/deployments?endpoint=missing&limit=2',
    );
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      data: [entry(live, 'dep-1'), entry(live, 'dep-2')],
      nextCursor: '2',
      hasMore: true,
    });
    const second = await call(
      ORCHESTRATOR,
      'GET',
      '/v1/system/deployments?endpoint=missing&limit=2&cursor=2',
    );
    expect(second.body).toEqual({ data: [entry(live, 'dep-3')], hasMore: false });
    expect(audit.at(-1)).toMatchObject({
      keyId: ORCHESTRATOR,
      scope: 'system:deployments',
      tenantId: '*',
      status: 200,
    });
  });

  test('an entry carries its project when the deploy had one, and none otherwise', async () => {
    const { call, deployments } = makeApp();
    const project = randomUUID();
    deployments.needing.push({ ...entry(live, 'dep-p'), projectId: project }, entry(live, 'dep-t'));
    const r = await call(ORCHESTRATOR, 'GET', '/v1/system/deployments?endpoint=missing');
    const data = r.body.data as Record<string, unknown>[];
    expect(data[0]).toMatchObject({ packId: 'acme.aperture', projectId: project });
    expect('projectId' in (data[1] as object)).toBe(false);
  });

  test('missing: an entry carries its last problem, with when it was first recorded', async () => {
    const { call, deployments } = makeApp();
    const problem = { code: 'pack-env-name-too-long' as const, since: NOW };
    deployments.needing.push({ ...entry(live, 'dep-p'), problem }, entry(live, 'dep-n'));
    const r = await call(ORCHESTRATOR, 'GET', '/v1/system/deployments?endpoint=missing');
    expect(r.status).toBe(200);
    const data = r.body.data as Record<string, unknown>[];
    expect(data[0]).toEqual({ ...entry(live, 'dep-p'), problem });
    expect('problem' in (data[1] as object)).toBe(false);
  });

  test('a cursor the binding never gave: 400, start again without it', async () => {
    const { call } = makeApp();
    const r = await call(
      ORCHESTRATOR,
      'GET',
      '/v1/system/deployments?endpoint=missing&cursor=forged',
    );
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
    expect((r.body.error as { message: string }).message).toContain('start again without it');
  });

  test('missing and ready: each entry says whether its service is kept warm, when the binding says', async () => {
    const { call, deployments } = makeApp();
    deployments.needing.push({ ...entry(live, 'dep-w'), warm: true }, entry(live, 'dep-n'));
    deployments.ready.push({ ...entry(live, 'dep-r'), warm: false });
    const missing = await call(ORCHESTRATOR, 'GET', '/v1/system/deployments?endpoint=missing');
    const data = missing.body.data as Record<string, unknown>[];
    expect(data[0]).toEqual({ ...entry(live, 'dep-w'), warm: true });
    expect('warm' in (data[1] as object)).toBe(false);
    const r = await call(ORCHESTRATOR, 'GET', '/v1/system/deployments?endpoint=ready');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [{ ...entry(live, 'dep-r'), warm: false }], hasMore: false });
  });

  test('retire: each entry with its reason', async () => {
    const { call, deployments } = makeApp();
    deployments.retiring.push(
      { ...entry(live, 'dep-old'), reason: 'superseded' },
      { ...entry(closing, 'dep-c'), reason: 'tenant-closing' },
    );
    const r = await call(ORCHESTRATOR, 'GET', '/v1/system/deployments?endpoint=retire');
    expect(r.status).toBe(200);
    expect((r.body.data as { reason: string }[]).map((e) => e.reason)).toEqual([
      'superseded',
      'tenant-closing',
    ]);
  });

  test.each([
    ['no endpoint filter', ''],
    ['another filter', '?endpoint=all'],
    ['a limit out of range', '?endpoint=missing&limit=101'],
    ['a limit that is no integer', '?endpoint=missing&limit=2.5'],
  ])('%s: 400 bad-input', async (_, query) => {
    const { call } = makeApp();
    const r = await call(ORCHESTRATOR, 'GET', `/v1/system/deployments${query}`);
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
  });
});

describe('the scopes: system:deployments for the endpoint, system:suspend for the pack', () => {
  const d = 'dep-1';
  const routes: [string, string, unknown][] = [
    ['GET', '/v1/system/deployments?endpoint=missing', undefined],
    ['PUT', endpointPath(live, d), body(`https://${hostFor(live, d)}`)],
    ['DELETE', endpointPath(live, d), undefined],
    ['PUT', `${endpointPath(live, d)}/problem`, { code: 'capacity-unavailable' }],
    ['PUT', `/v1/system/tenants/${live}/deployments/${d}/suspended`, { suspended: true }],
  ];

  test('a key with neither scope is refused on all five, before its body is read', async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, d);
    for (const [method, path, b] of routes) {
      // A valid body, and one that isn't: the scope is checked first either way.
      for (const sent of b === undefined ? [undefined] : [b, {}]) {
        const r = await call(TENANTS, method, path, sent);
        expect(r.status, `${method} ${path} ${JSON.stringify(sent)}`).toBe(403);
        expect(code(r), `${method} ${path} ${JSON.stringify(sent)}`).toBe('system-scope-missing');
      }
    }
    expect(deployments.set).toEqual([]);
  });

  test("the orchestrator's key can't suspend or restore a pack", async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, d);
    const r = await call(
      ORCHESTRATOR,
      'PUT',
      `/v1/system/tenants/${live}/deployments/${d}/suspended`,
      {
        suspended: false,
      },
    );
    expect(r.status).toBe(403);
    expect(details(r)).toMatchObject({ scope: 'system:suspend' });
    expect(deployments.suspendedPacks.size).toBe(0);
  });

  test("support's key can't list, set, clear or record a problem", async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, d);
    for (const [method, path, b] of routes.slice(0, 4)) {
      const r = await call(SUPPORT, method, path, b);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(details(r), `${method} ${path}`).toMatchObject({ scope: 'system:deployments' });
    }
  });

  test("a tenant's key, whatever it holds, never reaches them", async () => {
    const { call } = makeApp();
    for (const [method, path, b] of routes) {
      const r = await call(TENANT_KEY, method, path, b);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe('system-principal-required');
    }
  });

  test('the full system capability holds both', async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, d);
    const set = await call(FULL, 'PUT', endpointPath(live, d), body(`https://${hostFor(live, d)}`));
    expect(set.status).toBe(200);
    const pause = await call(FULL, 'PUT', `/v1/system/tenants/${live}/deployments/${d}/suspended`, {
      suspended: true,
    });
    expect(pause.status).toBe(200);
  });
});

describe('PUT …/endpoint', () => {
  test('ready, with the URL reduced to its origin; the answer and the access record carry no URL or token', async () => {
    const { call, deployments, audit } = makeApp();
    deployments.add(live, 'dep-1');
    const host = hostFor(live, 'dep-1');
    const r = await call(
      ORCHESTRATOR,
      'PUT',
      endpointPath(live, 'dep-1'),
      body(`https://${host}/`),
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ status: 'ready', since: NOW });
    expect(deployments.set).toEqual([
      {
        tenantId: live,
        deploymentId: 'dep-1',
        url: `https://${host}`,
        auth: 'google-id-token',
        token: PACK_TOKEN,
      },
    ]);
    expect(r.text).not.toContain(PACK_TOKEN);
    expect(r.text).not.toContain(host);
    expect(JSON.stringify(audit)).not.toContain(PACK_TOKEN);
    expect(audit.at(-1)).toMatchObject({
      keyId: ORCHESTRATOR,
      method: 'PUT',
      scope: 'system:deployments',
      tenantId: live,
      status: 200,
    });
  });

  test.each([
    ['plain http', (h: string) => `http://${h}`],
    ['user info', (h: string) => `https://user:pw@${h}`],
    ['a path', (h: string) => `https://${h}/v1`],
    ['a query', (h: string) => `https://${h}/?x=1`],
    ['a fragment', (h: string) => `https://${h}/#x`],
    ['no URL at all', () => 'kp-something'],
  ])('check 1, %s: 400 endpoint-url-invalid, on record as the problem', async (_, url) => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const r = await call(
      ORCHESTRATOR,
      'PUT',
      endpointPath(live, 'dep-1'),
      body(url(hostFor(live, 'dep-1'))),
    );
    expect(r.status).toBe(400);
    expect(code(r)).toBe('endpoint-url-invalid');
    expect(deployments.set).toEqual([]);
    expect(deployments.endpoints.get(deployments.key(live, 'dep-1'))?.problem?.code).toBe(
      'endpoint-url-invalid',
    );
  });

  test("check 2: a host off the operator's allowlist, even with the right name, is 422 and on record", async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const rightNameElsewhere = `${packServiceName(live, 'dep-1')}-999999999999.us-central1.run.app`;
    const r = await call(
      ORCHESTRATOR,
      'PUT',
      endpointPath(live, 'dep-1'),
      body(`https://${rightNameElsewhere}`),
    );
    expect(r.status).toBe(422);
    expect(code(r)).toBe('endpoint-host-not-allowed');
    expect(deployments.set).toEqual([]);
    expect(deployments.endpoints.get(deployments.key(live, 'dep-1'))?.problem?.code).toBe(
      'endpoint-host-not-allowed',
    );
  });

  test("check 3: an allowed host naming another deployment's service, or a longer name, is 422 naming the expected one", async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const other = randomUUID() as TenantId;
    for (const host of [
      hostFor(live, 'dep-2'),
      hostFor(other, 'dep-1'),
      `${packServiceName(live, 'dep-1')}x${RUN_TAIL}`,
    ]) {
      const r = await call(
        ORCHESTRATOR,
        'PUT',
        endpointPath(live, 'dep-1'),
        body(`https://${host}`),
      );
      expect(r.status, host).toBe(422);
      expect(code(r), host).toBe('endpoint-name-mismatch');
      expect(details(r), host).toMatchObject({ expected: packServiceName(live, 'dep-1') });
    }
    expect(deployments.set).toEqual([]);
  });

  test('check 3 holds under a domain allowlist too: a host it admits must still name the service', async () => {
    // `*.packs.internal`: one label in front of the domain, as the env parser reads it.
    const { call, deployments } = makeApp({
      hostAllowed: (host) => /^[a-z0-9-]+\.packs\.internal$/.test(host),
    });
    deployments.add(live, 'dep-1');
    for (const host of [
      'packs.packs.internal',
      `${packServiceName(live, 'dep-2')}.packs.internal`,
    ]) {
      const r = await call(
        ORCHESTRATOR,
        'PUT',
        endpointPath(live, 'dep-1'),
        body(`https://${host}`),
      );
      expect(r.status, host).toBe(422);
      expect(code(r), host).toBe('endpoint-name-mismatch');
    }
    expect(deployments.set).toEqual([]);
    const own = `https://${packServiceName(live, 'dep-1')}.packs.internal`;
    const ok = await call(ORCHESTRATOR, 'PUT', endpointPath(live, 'dep-1'), body(own));
    expect(ok.status).toBe(200);
    expect(deployments.set).toHaveLength(1);
  });

  test.each([
    [{ kind: 'refused', code: 'endpoint-unreachable' }, 422, 'endpoint-unreachable'],
    [
      {
        kind: 'refused',
        code: 'endpoint-info-mismatch',
        differs: ['artifactVersion', 'indexHash'],
      },
      422,
      'endpoint-info-mismatch',
    ],
    [{ kind: 'refused', code: 'image-not-allowed' }, 409, 'image-not-allowed'],
    [{ kind: 'suspended', reason: 'project-suspended' }, 409, 'project-suspended'],
    [{ kind: 'suspended', reason: 'pack-suspended' }, 409, 'pack-suspended'],
  ] as [SetPackEndpointOutcome, number, string][])(
    "the binding's refusal %j: %i %s",
    async (outcome, status, expected) => {
      const { call, deployments } = makeApp();
      deployments.add(live, 'dep-1');
      deployments.outcomes.set('dep-1', outcome);
      const r = await call(
        ORCHESTRATOR,
        'PUT',
        endpointPath(live, 'dep-1'),
        body(`https://${hostFor(live, 'dep-1')}`),
      );
      expect(r.status).toBe(status);
      expect(code(r)).toBe(expected);
      if (outcome.kind === 'refused' && outcome.differs !== undefined) {
        expect(details(r)).toMatchObject({ differs: outcome.differs });
      }
    },
  );

  test.each([
    [closing, 409, 'tenant-closing'],
    [suspended, 409, 'tenant-suspended'],
    [randomUUID(), 404, 'tenant-not-found'],
  ])(
    "a tenant that isn't live (%s): %i %s, and nothing is set",
    async (tenant, status, expected) => {
      const { call, deployments } = makeApp();
      deployments.add(tenant as TenantId, 'dep-1');
      const r = await call(
        ORCHESTRATOR,
        'PUT',
        endpointPath(tenant, 'dep-1'),
        body(`https://${hostFor(tenant, 'dep-1')}`),
      );
      expect(r.status).toBe(status);
      expect(code(r)).toBe(expected);
      expect(deployments.set).toEqual([]);
    },
  );

  test('a deployment the tenant has no such one of: 404, whether a check or the binding finds it', async () => {
    const { call } = makeApp();
    const refused = await call(ORCHESTRATOR, 'PUT', endpointPath(live, 'dep-9'), body('http://x'));
    expect(refused.status).toBe(404);
    expect(code(refused)).toBe('deployment-not-found');
    const unknown = await call(
      ORCHESTRATOR,
      'PUT',
      endpointPath(live, 'dep-9'),
      body(`https://${hostFor(live, 'dep-9')}`),
    );
    expect(unknown.status).toBe(404);
    expect(code(unknown)).toBe('deployment-not-found');
  });

  test.each([
    ['no auth', { url: 'https://h', token: PACK_TOKEN }],
    ['another auth', { url: 'https://h', auth: 'basic', token: PACK_TOKEN }],
    ['a short token', { url: 'https://h', auth: 'token', token: 'short' }],
    [
      'a token a header cannot carry',
      { url: 'https://h', auth: 'token', token: 'two words in a token' },
    ],
    ['a url that is no string', { url: 1, auth: 'token', token: PACK_TOKEN }],
  ])('%s: 400 bad-input', async (_, b) => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const r = await call(ORCHESTRATOR, 'PUT', endpointPath(live, 'dep-1'), b);
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
  });
});

describe('DELETE …/endpoint', () => {
  test("cleared, for a closing tenant too: that's how its services are retired", async () => {
    const { call, deployments } = makeApp();
    deployments.add(closing, 'dep-c');
    const r = await call(ORCHESTRATOR, 'DELETE', endpointPath(closing, 'dep-c'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'cleared', since: NOW });
  });

  test('an unknown deployment is 404', async () => {
    const { call } = makeApp();
    const r = await call(ORCHESTRATOR, 'DELETE', endpointPath(live, 'dep-9'));
    expect(r.status).toBe(404);
    expect(code(r)).toBe('deployment-not-found');
  });
});

describe('PUT …/endpoint/problem', () => {
  test("a pending deployment's problem, as the tenant will see it", async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const r = await call(ORCHESTRATOR, 'PUT', `${endpointPath(live, 'dep-1')}/problem`, {
      code: 'tenant-not-provisioned',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: 'pending',
      since: NOW,
      problem: { code: 'tenant-not-provisioned', since: NOW },
    });
  });

  test.each([['free text'], ['shard-full'], [42]])('a code off the list (%j): 400', async (c) => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const r = await call(ORCHESTRATOR, 'PUT', `${endpointPath(live, 'dep-1')}/problem`, {
      code: c,
    });
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
  });

  test("a cleared deployment that's waiting (a suspension lifted): its problem, as the tenant will see it", async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    expect((await call(ORCHESTRATOR, 'DELETE', endpointPath(live, 'dep-1'))).status).toBe(200);
    deployments.needing.push(entry(live, 'dep-1'));
    const r = await call(ORCHESTRATOR, 'PUT', `${endpointPath(live, 'dep-1')}/problem`, {
      code: 'service-start-failed',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: 'cleared',
      since: NOW,
      problem: { code: 'service-start-failed', since: NOW },
      waiting: true,
    });
  });

  test('a cleared deployment no pack service is wanted for: 409 endpoint-not-pending, saying so', async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    await call(ORCHESTRATOR, 'DELETE', endpointPath(live, 'dep-1'));
    const r = await call(ORCHESTRATOR, 'PUT', `${endpointPath(live, 'dep-1')}/problem`, {
      code: 'service-start-failed',
    });
    expect(r.status).toBe(409);
    expect(code(r)).toBe('endpoint-not-pending');
    expect(details(r)).toMatchObject({ status: 'cleared' });
    expect(JSON.stringify(r.body)).toContain('not waiting for a pack service');
  });

  test('a ready deployment: 409 endpoint-not-pending, naming its status', async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    await call(
      ORCHESTRATOR,
      'PUT',
      endpointPath(live, 'dep-1'),
      body(`https://${hostFor(live, 'dep-1')}`),
    );
    const r = await call(ORCHESTRATOR, 'PUT', `${endpointPath(live, 'dep-1')}/problem`, {
      code: 'service-start-failed',
    });
    expect(r.status).toBe(409);
    expect(code(r)).toBe('endpoint-not-pending');
    expect(details(r)).toMatchObject({ status: 'ready' });
  });
});

describe('PUT …/suspended (the pack)', () => {
  test("a closing tenant's pack: 409 tenant-closing; a suspended tenant's pack can still be suspended or restored", async () => {
    const { call, deployments } = makeApp();
    deployments.add(closing, 'dep-c');
    deployments.add(suspended, 'dep-s');
    const refused = await call(
      SUPPORT,
      'PUT',
      `/v1/system/tenants/${closing}/deployments/dep-c/suspended`,
      {
        suspended: true,
      },
    );
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('tenant-closing');
    expect(deployments.suspendedPacks.has(deployments.key(closing, 'dep-c'))).toBe(false);
    for (const on of [true, false]) {
      const r = await call(
        SUPPORT,
        'PUT',
        `/v1/system/tenants/${suspended}/deployments/dep-s/suspended`,
        {
          suspended: on,
        },
      );
      expect(r.status, String(on)).toBe(200);
    }
  });

  test('suspends and restores, with a reason for the record', async () => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const path = `/v1/system/tenants/${live}/deployments/dep-1/suspended`;
    const on = await call(SUPPORT, 'PUT', path, { suspended: true, reason: 'abuse report 7' });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ suspended: true, since: NOW });
    const off = await call(SUPPORT, 'PUT', path, { suspended: false });
    expect(off.body).toEqual({ suspended: false, since: NOW });
  });

  test.each([
    ['no suspended', {}],
    ['a suspended that is no boolean', { suspended: 'yes' }],
    ['an empty reason', { suspended: true, reason: ' ' }],
  ])('%s: 400', async (_, b) => {
    const { call, deployments } = makeApp();
    deployments.add(live, 'dep-1');
    const r = await call(
      SUPPORT,
      'PUT',
      `/v1/system/tenants/${live}/deployments/dep-1/suspended`,
      b,
    );
    expect(r.status).toBe(400);
  });
});
