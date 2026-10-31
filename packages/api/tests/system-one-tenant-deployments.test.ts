// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { isOneTenantDeploymentRoute } from '../src/system.js';

import { SYSTEM_TENANT_ID, createApp, packServiceName } from '../src/index.js';
import type {
  CreateAppInput,
  DeploymentEndpoint,
  RunHandlerBinding,
  SystemAccessRecord,
  SystemDeploymentEntry,
  SystemDeploymentsBinding,
  SystemKeyRecord,
  SystemKeysBinding,
} from '../src/index.js';

/**
 * A runtime serving one tenant that runs a pack service per deployment:
 * its own token mints its orchestrator's keys (`system:deployments`,
 * `system:pack-env`), and they reach the orchestrator's routes under
 * `/v1/system/*` and nothing else. A license key reaches none of them, and
 * a key holding a scope one tenant doesn't serve is refused everywhere.
 */

const tenantId = randomUUID() as TenantId;
const BOOT = 'kgi_bt_single';
const RUN_TAIL = '-123456789012.us-central1.run.app';
const NOW = '2026-10-30T12:00:00.000Z';

function entry(deploymentId: string): SystemDeploymentEntry {
  return {
    tenantId,
    deploymentId,
    packId: 'acme.aperture',
    imageRef: `us-central1-docker.pkg.dev/acme/packs/pack@sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    artifactVersion: '20261030.1',
    activatedAt: NOW,
  };
}

/** One deployment, and the orchestrator's round, in memory. */
function makeDeployments(options: { readonly round?: boolean } = {}) {
  const endpoints = new Map<string, DeploymentEndpoint>([
    ['dep-1', { status: 'pending', since: NOW }],
  ]);
  const round: { claimant?: string; until?: Date } = {};
  const binding: SystemDeploymentsBinding = {
    async listNeedingEndpoint() {
      return { kind: 'ok', data: [entry('dep-1')] };
    },
    async listToRetire() {
      return { kind: 'ok', data: [] };
    },
    async setEndpoint({ deploymentId }) {
      if (!endpoints.has(deploymentId)) return { kind: 'not-found' };
      const endpoint: DeploymentEndpoint = { status: 'ready', since: NOW };
      endpoints.set(deploymentId, endpoint);
      return { kind: 'ok', endpoint };
    },
    async clearEndpoint({ deploymentId }) {
      if (!endpoints.has(deploymentId)) return { kind: 'not-found' };
      const endpoint: DeploymentEndpoint = { status: 'cleared', since: NOW };
      endpoints.set(deploymentId, endpoint);
      return { kind: 'ok', endpoint };
    },
    async recordProblem({ deploymentId }) {
      const current = endpoints.get(deploymentId);
      if (current === undefined) return { kind: 'not-found' };
      return { kind: 'not-pending', endpoint: current };
    },
    async setSuspended() {
      throw new Error('serving one tenant, nothing suspends a pack through a key');
    },
    ...(options.round !== false && {
      async claimRound({ claimant, now, holdUntil }) {
        // A live claim holds it, the claimant's own too: a claim isn't renewed.
        if (round.until !== undefined && round.until > now) return { kind: 'held' };
        round.claimant = claimant;
        round.until = holdUntil;
        return { kind: 'ok' };
      },
      async endRound({ claimant }) {
        if (round.claimant !== claimant) return { kind: 'not-held' };
        delete round.claimant;
        delete round.until;
        return { kind: 'ok' };
      },
    }),
  };
  return { binding, endpoints, round };
}

/** System keys in memory, resolving as system principals. */
function makeSystemKeys() {
  const keys = new Map<string, SystemKeyRecord & { readonly secret: string }>();
  const binding: SystemKeysBinding = {
    async mint(input) {
      const id = randomUUID();
      const secret = `kgi_sy_${id}_${randomBytes(16).toString('base64url')}`;
      const record = { id, scopes: input.scopes, createdAt: new Date(), mintedBy: input.mintedBy };
      keys.set(id, { ...record, secret });
      return { record, token: secret };
    },
    async list() {
      return [...keys.values()].map(({ secret: _secret, ...r }) => r);
    },
    async revoke() {
      return null;
    },
  };
  /** A key with any scopes, as one minted while the runtime served many tenants would be. */
  const plant = (scopes: readonly string[]): string => {
    const id = randomUUID();
    const secret = `kgi_sy_${id}_planted`;
    keys.set(id, { id, scopes, createdAt: new Date(), mintedBy: 'boot', secret });
    return secret;
  };
  return { binding, keys, plant };
}

function makeApp(options: { readonly deployments?: boolean; readonly round?: boolean } = {}) {
  const deployments = makeDeployments({
    ...(options.round !== undefined && { round: options.round }),
  });
  const system = makeSystemKeys();
  const audit: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    tenantStates: { of: async () => undefined },
    runHandler: {} as RunHandlerBinding,
    resolveToken: async (token) => {
      if (token === BOOT) {
        return {
          tenantId,
          userId: 'user-seed' as UserId,
          scopes: ['tenant-admin'],
          capabilities: ['kindgi:system'],
          systemKeysOperator: { keyId: 'boot' },
        };
      }
      const k = [...system.keys.values()].find((x) => x.secret === token);
      return k === undefined
        ? null
        : { tenantId: SYSTEM_TENANT_ID, system: { keyId: k.id }, capabilities: k.scopes };
    },
    systemKeys: system.binding,
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
    license: {
      status: () => ({ mode: 'licensed', name: 'Acme', use: 'production' }),
      usage: async ({ since, until }) => ({
        since: since.toISOString(),
        until: until.toISOString(),
        runtimeVersion: '0.0.0',
        runs: 0,
        people: 1,
      }),
    },
    ...(options.deployments !== false && {
      // The sole tenant alone, as a runtime serving one tenant names it.
      systemTenantDirectory: {
        async get(id) {
          return id === tenantId ? { id, state: 'active' } : null;
        },
      },
      systemDeployments: {
        binding: deployments.binding,
        endpointHostAllowed: (host: string) => host.endsWith(RUN_TAIL),
      },
    }),
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
    return {
      status: res.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };
  const mint = async (scopes: readonly string[]) => {
    const r = await call(BOOT, 'POST', '/v1/system/keys', { scopes });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as { token: string }).token;
  };
  return { app, call, mint, audit, deployments, system };
}

const code = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code;

const onDeployment = (d: string) => `/v1/system/tenants/${tenantId}/deployments/${d}`;
const endpointBody = (d: string) => ({
  url: `https://${packServiceName(tenantId, d)}${RUN_TAIL}`,
  auth: 'google-id-token',
  token: 'pack-token-0123456789abcdef',
});

/** Every route the orchestrator calls, with a body each would take. */
const ORCHESTRATOR_ROUTES: readonly [string, string, unknown?][] = [
  ['GET', '/v1/system/deployments?endpoint=missing'],
  ['POST', '/v1/system/deployments/round', { claimant: 'pass-1', holdSeconds: 300 }],
  ['POST', '/v1/system/deployments/round/end', { claimant: 'pass-1' }],
  ['GET', '/v1/system/pack-env'],
  ['PUT', `${onDeployment('dep-1')}/endpoint`, endpointBody('dep-1')],
  ['DELETE', `${onDeployment('dep-1')}/endpoint`],
  ['PUT', `${onDeployment('dep-1')}/endpoint/problem`, { code: 'capacity-unavailable' }],
  ['GET', `${onDeployment('dep-1')}/pack-env`],
  ['PUT', `${onDeployment('dep-1')}/pack-env`, { revision: 'r1' }],
];

describe("serving one tenant with a pack service per deployment: the orchestrator's keys", () => {
  test("the deployment's own token mints them, and no scope past them", async () => {
    const { call } = makeApp();
    for (const scopes of [
      ['system:deployments'],
      ['system:pack-env'],
      ['system:deployments', 'system:pack-env'],
      ['system:license'],
    ]) {
      const r = await call(BOOT, 'POST', '/v1/system/keys', { scopes });
      expect(r.status, `${scopes.join(',')}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    for (const scopes of [['system:suspend'], ['system:tenants'], ['kindgi:system']]) {
      const r = await call(BOOT, 'POST', '/v1/system/keys', { scopes });
      expect(r.status, scopes.join(',')).toBe(400);
      expect(code(r)).toBe('bad-input');
    }
  });

  test('without per-deployment routing, they are not minted: the license key alone, as before', async () => {
    const { call } = makeApp({ deployments: false });
    const r = await call(BOOT, 'POST', '/v1/system/keys', { scopes: ['system:deployments'] });
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
  });

  test('a deployments key lists, records an endpoint and claims the round, each on the access record', async () => {
    const { call, mint, audit } = makeApp();
    const key = await mint(['system:deployments']);
    const listed = await call(key, 'GET', '/v1/system/deployments?endpoint=missing');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body.data as { deploymentId: string }[]).map((e) => e.deploymentId)).toEqual([
      'dep-1',
    ]);
    const set = await call(key, 'PUT', `${onDeployment('dep-1')}/endpoint`, endpointBody('dep-1'));
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.status).toBe('ready');
    const claimed = await call(key, 'POST', '/v1/system/deployments/round', {
      claimant: 'pass-1',
      holdSeconds: 300,
    });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.claimant).toBe('pass-1');
    expect(Date.parse(claimed.body.heldUntil as string)).toBeGreaterThan(Date.now() + 290_000);
    const paths = audit.map((a) => `${a.method} ${a.path} ${a.status}`);
    expect(paths).toContain('GET /v1/system/deployments 200');
    expect(paths).toContain(`PUT ${onDeployment('dep-1')}/endpoint 200`);
    expect(paths).toContain('POST /v1/system/deployments/round 200');
  });

  test('a route naming another tenant is a 404: the directory knows the sole tenant alone', async () => {
    const { call, mint } = makeApp();
    const key = await mint(['system:deployments']);
    const other = randomUUID();
    const r = await call(
      key,
      'PUT',
      `/v1/system/tenants/${other}/deployments/dep-1/endpoint`,
      endpointBody('dep-1'),
    );
    expect(r.status).toBe(404);
    expect(code(r)).toBe('tenant-not-found');
  });

  test('a deployments key reaches nothing else: the license, the keys, the tenants, the suspend route, a tenant route', async () => {
    const { call, mint } = makeApp();
    const key = await mint(['system:deployments']);
    const refusals: [string, string, string][] = [
      ['GET', '/v1/license', 'system-scope-missing'],
      ['GET', '/v1/license/usage', 'system-scope-missing'],
      ['GET', '/v1/system/keys', 'system-scope-missing'],
      ['GET', '/v1/system/tenants', 'system-scope-missing'],
      ['GET', '/v1/system/usage', 'system-scope-missing'],
      ['PUT', `${onDeployment('dep-1')}/suspended`, 'system-scope-missing'],
      ['GET', '/v1/system/deployments/', 'system-scope-missing'],
      ['GET', '/v1/agents', 'system-key-on-tenant-route'],
      // Its own scope's routes only: the pack env takes `system:pack-env`.
      ['GET', '/v1/system/pack-env', 'system-scope-missing'],
      ['GET', `${onDeployment('dep-1')}/pack-env`, 'system-scope-missing'],
    ];
    for (const [method, path, expected] of refusals) {
      const r = await call(key, method, path, method === 'PUT' ? { suspended: true } : undefined);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe(expected);
    }
  });

  test('no key the orchestrator holds reaches the suspend route: a pack env key, or one holding both scopes', async () => {
    const { call, mint } = makeApp();
    for (const scopes of [['system:pack-env'], ['system:deployments', 'system:pack-env']]) {
      const key = await mint(scopes);
      const r = await call(key, 'PUT', `${onDeployment('dep-1')}/suspended`, { suspended: true });
      expect(r.status, `${scopes.join(',')}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(code(r), scopes.join(',')).toBe('system-scope-missing');
    }
  });

  test("a license key reaches none of the orchestrator's routes", async () => {
    const { call, mint } = makeApp();
    const key = await mint(['system:license']);
    for (const [method, path, body] of ORCHESTRATOR_ROUTES) {
      const r = await call(key, method, path, body);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe('system-scope-missing');
    }
    expect((await call(key, 'GET', '/v1/license')).status).toBe(200);
  });

  test('a key holding a scope one tenant does not serve is refused on every route', async () => {
    const { call, system } = makeApp();
    for (const scopes of [
      ['system:deployments', 'system:suspend'],
      ['system:tenants'],
      ['kindgi:system'],
    ]) {
      const key = system.plant(scopes);
      for (const [method, path, body] of [
        ...ORCHESTRATOR_ROUTES,
        ['GET', '/v1/license'] as [string, string],
      ]) {
        const r = await call(key, method, path, body);
        expect(r.status, `${scopes.join(',')} ${method} ${path}`).toBe(403);
        expect(code(r), `${scopes.join(',')} ${method} ${path}`).toBe(
          'system-key-scope-not-served',
        );
      }
    }
  });

  test("the deployment's own token is a system principal on /v1/system/keys alone, not on these", async () => {
    const { call } = makeApp();
    for (const [method, path, body] of ORCHESTRATOR_ROUTES) {
      const r = await call(BOOT, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe('system-principal-required');
    }
  });

  test('without per-deployment routing, a planted deployments key is refused as one tenant always refused it', async () => {
    const { call, system } = makeApp({ deployments: false });
    const key = system.plant(['system:deployments']);
    const r = await call(key, 'GET', '/v1/system/deployments?endpoint=missing');
    expect(r.status).toBe(403);
    expect(code(r)).toBe('system-key-scope-not-served');
  });

  test('systemDeployments needs the access record', () => {
    const { binding } = makeDeployments();
    const input = {
      ...createStubAppBindings(),
      runHandler: {} as RunHandlerBinding,
      resolveToken: async () => null,
      systemTenantDirectory: { get: async () => null },
      systemDeployments: { binding, endpointHostAllowed: () => true },
    } satisfies Partial<CreateAppInput> as CreateAppInput;
    expect(() => createApp(input)).toThrow(/systemDeployments needs systemAccessAudit/);
  });
});

describe("the orchestrator's round", () => {
  test('one pass at a time: a second claim is a 409, the end lets the next one claim', async () => {
    const { call, mint } = makeApp();
    const key = await mint(['system:deployments']);
    const first = await call(key, 'POST', '/v1/system/deployments/round', {
      claimant: 'pass-1',
      holdSeconds: 300,
    });
    expect(first.status).toBe(200);
    const second = await call(key, 'POST', '/v1/system/deployments/round', {
      claimant: 'pass-2',
      holdSeconds: 300,
    });
    expect(second.status).toBe(409);
    expect(code(second)).toBe('orchestrator-round-held');
    const notMine = await call(key, 'POST', '/v1/system/deployments/round/end', {
      claimant: 'pass-2',
    });
    expect(notMine.status).toBe(409);
    expect(code(notMine)).toBe('orchestrator-round-not-held');
    const ended = await call(key, 'POST', '/v1/system/deployments/round/end', {
      claimant: 'pass-1',
    });
    expect(ended.status).toBe(204);
    const next = await call(key, 'POST', '/v1/system/deployments/round', {
      claimant: 'pass-2',
      holdSeconds: 300,
    });
    expect(next.status).toBe(200);
  });

  test('a bad claimant or hold is a 400', async () => {
    const { call, mint } = makeApp();
    const key = await mint(['system:deployments']);
    for (const body of [
      {},
      { claimant: '', holdSeconds: 300 },
      { claimant: 'has space', holdSeconds: 300 },
      { claimant: 'x'.repeat(129), holdSeconds: 300 },
      { claimant: 'pass-1' },
      { claimant: 'pass-1', holdSeconds: 29 },
      { claimant: 'pass-1', holdSeconds: 3601 },
      { claimant: 'pass-1', holdSeconds: 300.5 },
    ]) {
      const r = await call(key, 'POST', '/v1/system/deployments/round', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(code(r)).toBe('bad-input');
    }
  });

  test('a binding that keeps no round answers 501', async () => {
    const { call, mint } = makeApp({ round: false });
    const key = await mint(['system:deployments']);
    for (const path of ['/v1/system/deployments/round', '/v1/system/deployments/round/end']) {
      const r = await call(key, 'POST', path, { claimant: 'pass-1', holdSeconds: 300 });
      expect(r.status, path).toBe(501);
      expect(code(r)).toBe('orchestrator-round-unsupported');
    }
  });
});

describe('the routes a system key reaches serving one tenant', () => {
  test("isOneTenantDeploymentRoute: the orchestrator's routes, by method, and nothing near them", () => {
    for (const [method, path] of ORCHESTRATOR_ROUTES) {
      expect(
        isOneTenantDeploymentRoute(method, path.split('?')[0] as string),
        `${method} ${path}`,
      ).toBe(true);
    }
    for (const [method, path] of [
      ['POST', '/v1/system/deployments'],
      ['GET', '/v1/system/deployments/'],
      ['GET', '/v1/system/deployments/round'],
      ['PUT', `${onDeployment('dep-1')}/suspended`],
      ['GET', `${onDeployment('dep-1')}/endpoint`],
      ['PUT', `/v1/system/tenants/${tenantId}/deployments/dep-1/endpoint/x`],
      ['PUT', `/v1/system/tenants/${tenantId}/x/deployments/dep-1/endpoint`],
      ['GET', '/v1/system/keys'],
      ['GET', '/v1/system/tenants'],
      ['GET', '/v1/license'],
    ] as const) {
      expect(isOneTenantDeploymentRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
