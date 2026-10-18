// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp, packServiceName } from '../src/index.js';
import type {
  Deployment,
  DeploymentBinding,
  DeploymentEndpoint,
  EnvBinding,
  EnvRecord,
  PackEnvRecordInput,
  RunHandlerBinding,
  SetPackEndpointInput,
  SystemDeploymentsBinding,
  SystemPackEnvServed,
  SystemTenantState,
} from '../src/index.js';

/**
 * The pack env routes behind per-deployment routing. The orchestrator, on a
 * key of its own (`system:pack-env`), lists the deployments whose pack
 * service runs on values that changed, reads a deployment's values, and
 * records what its service runs. A tenant reads where each declared name is
 * set, never a value.
 */

const live = randomUUID() as TenantId;
const closing = randomUUID() as TenantId;
const suspended = randomUUID() as TenantId;
const STATES = new Map<string, SystemTenantState>([
  [live, 'active'],
  [closing, 'closing'],
  [suspended, 'suspended'],
]);
const staging = randomUUID() as ProjectId;
const prod = randomUUID() as ProjectId;
const envName = 'prod' as EnvName;

const PACK_ENV = 'kgi_sy_pack_env';
const ORCHESTRATOR = 'kgi_sy_orchestrator';
const FULL = 'kgi_sy_full';
const TENANT_KEY = 'kgi_ak_tenant_reader';
const SCOPES: Record<string, readonly string[]> = {
  [PACK_ENV]: ['system:pack-env'],
  [ORCHESTRATOR]: ['system:deployments'],
  [FULL]: ['kindgi:system'],
};
const NOW = '2026-10-18T03:00:00.000Z';

function deployment(id: string, projectId: ProjectId, endpoint: DeploymentEndpoint): Deployment {
  return {
    deploymentId: id,
    tenantId: live,
    imageRef: `us-central1-docker.pkg.dev/acme-shard/s-1/pack@sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    artifactVersion: '20261018.1',
    indexHash: 'b'.repeat(64),
    signerKeyId: 'k1' as never,
    signerPublicKey: 'pk',
    signature: 'sig',
    publishedAt: NOW,
    activatedAt: NOW,
    projectId,
    endpoint,
    packEnv: { required: ['API_BASE'], optional: ['LOG_LEVEL'] },
    primitives: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
    contents: { tools: [], guardrails: [], agents: [], flows: [] },
  };
}

function served(d: Deployment, applied?: string): SystemPackEnvServed {
  return {
    tenantId: d.tenantId,
    deploymentId: d.deploymentId,
    packId: 'acme.aperture',
    ...(d.projectId !== undefined && { projectId: d.projectId }),
    imageRef: d.imageRef,
    imageDigest: d.imageDigest,
    artifactVersion: d.artifactVersion,
    activatedAt: d.activatedAt,
    packEnv: d.packEnv ?? { required: [], optional: [] },
    ...(applied !== undefined && { appliedRevision: applied }),
  };
}

function makeApp(
  options: { readonly withPackEnv?: boolean; readonly perDeployment?: boolean } = {},
) {
  const withPackEnv = options.withPackEnv ?? true;
  const perDeployment = options.perDeployment ?? true;
  const envRows = new Map<string, EnvRecord>();
  const scopeKey = (s: Scope) =>
    s.kind === 'project' ? `p:${s.projectId}` : s.kind === 'org' ? `o:${s.orgId}` : 't';
  let clock = Date.parse(NOW);
  const setEnv = (scope: Scope, name: string, value: string) => {
    const at = new Date(clock++).toISOString();
    const old = envRows.get(`${scopeKey(scope)}|${name}`);
    envRows.set(`${scopeKey(scope)}|${name}`, {
      scope,
      envName,
      name,
      value,
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    });
  };
  const env = {
    async get({ scope, envName: e, name }) {
      return e === envName ? (envRows.get(`${scopeKey(scope)}|${name}`) ?? null) : null;
    },
  } as EnvBinding;
  const deployments = new Map<string, Deployment>();
  const registry = {
    async get({ tenantId, deploymentId }) {
      const d = deployments.get(deploymentId);
      return d !== undefined && d.tenantId === tenantId ? d : null;
    },
  } as DeploymentBinding;
  const servedList: SystemPackEnvServed[] = [];
  const recorded: PackEnvRecordInput[] = [];
  const setInputs: SetPackEndpointInput[] = [];
  const applied = new Map<string, string>();
  const binding: SystemDeploymentsBinding = {
    async listNeedingEndpoint() {
      return { kind: 'ok', data: [] };
    },
    async listToRetire() {
      return { kind: 'ok', data: [] };
    },
    async setEndpoint(input) {
      setInputs.push(input);
      return { kind: 'ok', endpoint: { status: 'ready', since: NOW } };
    },
    async clearEndpoint() {
      return { kind: 'not-found' };
    },
    async recordProblem() {
      return { kind: 'not-found' };
    },
    async setSuspended() {
      return { kind: 'not-found' };
    },
    ...(withPackEnv && {
      async listServingPackEnv() {
        return { kind: 'ok' as const, data: servedList };
      },
      async recordPackEnv(input: PackEnvRecordInput) {
        const d = deployments.get(input.deploymentId);
        if (d === undefined || d.tenantId !== input.tenantId) return { kind: 'not-found' as const };
        if (d.endpoint?.status !== 'ready') {
          return { kind: 'not-ready' as const, endpoint: d.endpoint as DeploymentEndpoint };
        }
        const current = applied.get(input.deploymentId);
        if (current !== input.appliedRevision) {
          return {
            kind: 'conflict' as const,
            ...(current !== undefined && { appliedRevision: current }),
          };
        }
        recorded.push(input);
        if (input.held === undefined) applied.set(input.deploymentId, input.revision);
        const endpoint: DeploymentEndpoint = {
          status: 'ready',
          since: NOW,
          ...(input.held !== undefined && { packEnvProblem: { code: input.held, since: NOW } }),
        };
        return { kind: 'ok' as const, endpoint };
      },
    }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
    runHandler: {} as RunHandlerBinding,
    resolveToken: async (token) => {
      const scopes = SCOPES[token];
      if (scopes !== undefined) {
        return { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: scopes };
      }
      if (token === TENANT_KEY) return { tenantId: live, scopes: ['tenant-admin'] };
      return null;
    },
    systemAccessAudit: {
      async record() {},
      async begin() {
        return '0';
      },
      async finish() {},
    },
    tenantStates: { of: async () => undefined },
    systemTenantDirectory: {
      async get(id) {
        const state = STATES.get(id);
        return state === undefined ? null : { id, state };
      },
    },
    ...(perDeployment && {
      systemDeployments: { binding, endpointHostAllowed: () => true },
    }),
    deploymentRegistry: registry,
    signingKeyRegistry: {} as never,
    imageRegistry: {} as never,
    imagePrefixes: { of: async () => undefined },
    envBinding: env,
    envName,
    projectBinding: {
      async get(_t: TenantId, id: ProjectId) {
        return { id } as never;
      },
      async getDefault() {
        return undefined;
      },
    } as never,
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
      body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
      text,
    };
  };
  return { call, deployments, servedList, recorded, setInputs, setEnv, applied };
}

const code = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code;
const valuesPath = (t: string, d: string) => `/v1/system/tenants/${t}/deployments/${d}/pack-env`;
const ready: DeploymentEndpoint = { status: 'ready', since: NOW };

describe('GET /v1/system/tenants/{t}/deployments/{d}/pack-env', () => {
  test("the deployment's own project's values, with the revision", async () => {
    const a = makeApp();
    a.deployments.set(
      'd-staging',
      deployment('d-staging', staging, { status: 'pending', since: NOW }),
    );
    a.deployments.set('d-prod', deployment('d-prod', prod, ready));
    a.setEnv(
      { kind: 'project', tenantId: live, projectId: staging },
      'API_BASE',
      'https://staging.acme.test',
    );
    a.setEnv({ kind: 'project', tenantId: live, projectId: prod }, 'API_BASE', 'https://acme.test');
    const s = await a.call(PACK_ENV, 'GET', valuesPath(live, 'd-staging'));
    const p = await a.call(PACK_ENV, 'GET', valuesPath(live, 'd-prod'));
    expect(s.status).toBe(200);
    expect(s.body.env).toEqual({ API_BASE: 'https://staging.acme.test' });
    expect(p.body.env).toEqual({ API_BASE: 'https://acme.test' });
    expect(s.body.revision).toMatch(/^pe1-/);
    expect(s.body.problem).toBeUndefined();
  });

  test('no values while there is a problem, which names the name', async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, ready));
    const r = await a.call(PACK_ENV, 'GET', valuesPath(live, 'd'));
    expect(r.status).toBe(200);
    expect(r.body.problem).toBe('pack-env-missing');
    expect(r.body.env).toBeUndefined();
    expect(r.body.names).toContainEqual(
      expect.objectContaining({ name: 'API_BASE', problem: 'missing' }),
    );
  });

  test("the deployments key can't read a value: 403; the full system capability can", async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, ready));
    const r = await a.call(ORCHESTRATOR, 'GET', valuesPath(live, 'd'));
    expect(r.status).toBe(403);
    expect(code(r)).toBe('system-scope-missing');
    expect((await a.call(FULL, 'GET', valuesPath(live, 'd'))).status).toBe(200);
  });

  test("a tenant's own key: refused", async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, ready));
    const r = await a.call(TENANT_KEY, 'GET', valuesPath(live, 'd'));
    expect(r.status).toBe(403);
  });

  test("a retired deployment's values aren't given out: 409 endpoint-retired", async () => {
    const a = makeApp();
    a.deployments.set(
      'd',
      deployment('d', staging, { status: 'cleared', since: NOW, retired: 'superseded' }),
    );
    a.setEnv(
      { kind: 'project', tenantId: live, projectId: staging },
      'API_BASE',
      'https://x.acme.test',
    );
    const r = await a.call(PACK_ENV, 'GET', valuesPath(live, 'd'));
    expect(r.status).toBe(409);
    expect(code(r)).toBe('endpoint-retired');
    expect(r.text).not.toContain('x.acme.test');
  });

  test('a cleared one waiting for a pack service again is given its values', async () => {
    const a = makeApp();
    a.deployments.set(
      'd',
      deployment('d', staging, { status: 'cleared', since: NOW, waiting: true }),
    );
    a.setEnv(
      { kind: 'project', tenantId: live, projectId: staging },
      'API_BASE',
      'https://x.acme.test',
    );
    expect((await a.call(PACK_ENV, 'GET', valuesPath(live, 'd'))).status).toBe(200);
  });

  test('a closing or suspended tenant: refused; an unknown deployment: 404', async () => {
    const a = makeApp();
    expect(code(await a.call(PACK_ENV, 'GET', valuesPath(closing, 'd')))).toBe('tenant-closing');
    expect(code(await a.call(PACK_ENV, 'GET', valuesPath(suspended, 'd')))).toBe(
      'tenant-suspended',
    );
    const r = await a.call(PACK_ENV, 'GET', valuesPath(live, 'nope'));
    expect(r.status).toBe(404);
    expect(code(r)).toBe('deployment-not-found');
  });

  test("a binding that doesn't keep what a service runs: 501 pack-env-unsupported", async () => {
    const a = makeApp({ withPackEnv: false });
    const r = await a.call(PACK_ENV, 'GET', valuesPath(live, 'd'));
    expect(r.status).toBe(501);
    expect(code(r)).toBe('pack-env-unsupported');
  });
});

describe('GET /v1/system/pack-env', () => {
  test('lists only a service running on values that changed, ids only', async () => {
    const a = makeApp();
    const same = deployment('d-same', staging, ready);
    const changed = deployment('d-changed', prod, ready);
    a.deployments.set('d-same', same);
    a.deployments.set('d-changed', changed);
    a.setEnv(
      { kind: 'project', tenantId: live, projectId: staging },
      'API_BASE',
      'https://s.acme.test',
    );
    a.setEnv(
      { kind: 'project', tenantId: live, projectId: prod },
      'API_BASE',
      'https://p.acme.test',
    );
    const sameRevision = (await a.call(PACK_ENV, 'GET', valuesPath(live, 'd-same'))).body.revision;
    const oldRevision = (await a.call(PACK_ENV, 'GET', valuesPath(live, 'd-changed'))).body
      .revision;
    a.setEnv(
      { kind: 'project', tenantId: live, projectId: prod },
      'API_BASE',
      'https://p2.acme.test',
    );
    a.servedList.push(served(same, sameRevision as string), served(changed, oldRevision as string));
    const r = await a.call(PACK_ENV, 'GET', '/v1/system/pack-env');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      data: [
        {
          tenantId: live,
          deploymentId: 'd-changed',
          packId: 'acme.aperture',
          projectId: prod,
          imageRef: changed.imageRef,
          imageDigest: changed.imageDigest,
          artifactVersion: changed.artifactVersion,
          activatedAt: NOW,
        },
      ],
      hasMore: false,
    });
    expect(r.text).not.toContain('acme.test');
  });

  test('one never recorded is listed; one held back at this revision is not', async () => {
    const a = makeApp();
    const fresh = deployment('d-fresh', staging, ready);
    const held = deployment('d-held', prod, ready);
    a.deployments.set('d-held', held);
    const heldRevision = (await a.call(PACK_ENV, 'GET', valuesPath(live, 'd-held'))).body
      .revision as string;
    a.servedList.push(served(fresh), {
      ...served(held, 'pe1-older'),
      held: { revision: heldRevision, code: 'pack-env-missing' },
    });
    const r = await a.call(PACK_ENV, 'GET', '/v1/system/pack-env');
    expect((r.body.data as { deploymentId: string }[]).map((e) => e.deploymentId)).toEqual([
      'd-fresh',
    ]);
  });

  test('needs system:pack-env', async () => {
    const a = makeApp();
    expect((await a.call(ORCHESTRATOR, 'GET', '/v1/system/pack-env')).status).toBe(403);
  });
});

describe('PUT /v1/system/tenants/{t}/deployments/{d}/pack-env', () => {
  test('records what the service runs, compare-and-set on the one it was found running', async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, ready));
    const first = await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), { revision: 'pe1-a' });
    expect(first.status).toBe(200);
    const late = await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), { revision: 'pe1-b' });
    expect(late.status).toBe(409);
    expect(code(late)).toBe('pack-env-conflict');
    const next = await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), {
      revision: 'pe1-b',
      appliedRevision: 'pe1-a',
    });
    expect(next.status).toBe(200);
    expect(a.recorded.map((r) => r.revision)).toEqual(['pe1-a', 'pe1-b']);
  });

  test('held: the endpoint shows the problem, and its service keeps what it runs', async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, ready));
    const r = await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), {
      revision: 'pe1-c',
      held: 'pack-env-missing',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: 'ready',
      since: NOW,
      packEnvProblem: { code: 'pack-env-missing', since: NOW },
    });
    expect(a.applied.get('d')).toBeUndefined();
  });

  test('a pending one: 409 endpoint-not-ready; bad bodies: 400', async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, { status: 'pending', since: NOW }));
    const r = await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), { revision: 'pe1-a' });
    expect(r.status).toBe(409);
    expect(code(r)).toBe('endpoint-not-ready');
    for (const body of [{}, { revision: '' }, { revision: 'pe1-a', held: 'pack-env-other' }]) {
      expect((await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), body)).status).toBe(400);
    }
  });
});

describe('PUT …/endpoint with packEnvRevision', () => {
  test('the revision a new service was made with goes to the binding', async () => {
    const a = makeApp();
    const r = await a.call(
      ORCHESTRATOR,
      'PUT',
      `/v1/system/tenants/${live}/deployments/d/endpoint`,
      {
        url: `https://${packServiceName(live, 'd')}-123456789012.us-central1.run.app`,
        auth: 'google-id-token',
        token: 'pack-token-0123456789abcdef',
        packEnvRevision: 'pe1-new',
      },
    );
    expect(r.status).toBe(200);
    expect(a.setInputs.at(-1)?.packEnvRevision).toBe('pe1-new');
  });
});

describe('GET /v1/deployments/{id}/pack-env', () => {
  test('where each declared name is set, and never a value', async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, ready));
    a.setEnv(
      { kind: 'project', tenantId: live, projectId: staging },
      'API_BASE',
      'https://hidden.acme.test',
    );
    const r = await a.call(TENANT_KEY, 'GET', '/v1/deployments/d/pack-env');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      envName: 'prod',
      data: [
        {
          name: 'API_BASE',
          required: true,
          kind: 'env',
          scope: { kind: 'project', id: staging },
          missing: false,
        },
        { name: 'LOG_LEVEL', required: false, kind: null, scope: null, missing: true },
      ],
    });
    expect(r.text).not.toContain('hidden.acme.test');
  });

  test("a server that doesn't run a pack service per deployment: 501 pack-env-not-served", async () => {
    const a = makeApp({ perDeployment: false });
    a.deployments.set('d', deployment('d', staging, ready));
    const r = await a.call(TENANT_KEY, 'GET', '/v1/deployments/d/pack-env');
    expect(r.status).toBe(501);
    expect(code(r)).toBe('pack-env-not-served');
  });
});
