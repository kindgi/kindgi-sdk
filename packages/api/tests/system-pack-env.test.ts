// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Logger } from '@kindgi/log';
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
  SecretBinding,
  SecretError,
  SecretRecord,
  SecretResolveInput,
  SetPackEndpointInput,
  SystemDeploymentsBinding,
  SystemPackEnvServed,
  SystemTenantState,
} from '../src/index.js';

/**
 * The pack env routes behind per-deployment routing. The orchestrator, on a
 * key of its own (`system:pack-env`), lists the deployments whose pack
 * service runs on values that changed, reads a deployment's values, and
 * records what its service runs; with `?secrets=values`, the values of the
 * names set only as a secret too, each audited first. A tenant reads where
 * each declared name is set, never a value.
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
const FULL_AND_PACK_ENV = 'kgi_sy_full_and_pack_env';
const TENANT_KEY = 'kgi_ak_tenant_reader';
const SCOPES: Record<string, readonly string[]> = {
  [PACK_ENV]: ['system:pack-env'],
  [ORCHESTRATOR]: ['system:deployments'],
  [FULL]: ['kindgi:system'],
  [FULL_AND_PACK_ENV]: ['kindgi:system', 'system:pack-env'],
};
/** A system key's id, as its resolver gives it: never the token itself. */
const keyIdOf = (token: string) => `key-${Object.keys(SCOPES).indexOf(token)}`;
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
  options: {
    readonly withPackEnv?: boolean;
    readonly perDeployment?: boolean;
    /** A secret store, read with `get` and `resolve`. */
    readonly secrets?: boolean;
    /** Where values given out are audited: absent, none. */
    readonly audit?: 'ok' | 'refused' | 'throws';
    readonly logger?: Logger;
  } = {},
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
  const secretRows = new Map<string, SecretRecord & { readonly value: string }>();
  const secretFaults = new Map<string, SecretError['code']>();
  /** A name whose read the store answers from another scope than the one asked. */
  const answerFrom = new Map<string, Scope>();
  const resolved: SecretResolveInput[] = [];
  const setSecret = (scope: Scope, name: string, value: string) => {
    const at = new Date(clock++).toISOString();
    secretRows.set(`${scopeKey(scope)}|${name}`, {
      scope,
      envName,
      name,
      currentVersion: 1,
      createdAt: at,
      updatedAt: at,
      recordId: randomUUID(),
      value,
    });
  };
  const secrets = {
    async get({ scope, envName: e, name }) {
      const row = e === envName ? secretRows.get(`${scopeKey(scope)}|${name}`) : undefined;
      if (row === undefined) return null;
      const { value: _value, ...record } = row;
      return record;
    },
    async resolve(input) {
      resolved.push(input);
      const fault = secretFaults.get(input.name);
      const row = secretRows.get(`${scopeKey(input.scope)}|${input.name}`);
      if (fault !== undefined || row === undefined) {
        const code = fault ?? 'secret-not-found';
        const message = `the store's own words about ${input.name}`;
        return { kind: 'err', error: { code, message, name: input.name } as SecretError };
      }
      return {
        kind: 'ok',
        value: {
          name: input.name,
          versionId: row.currentVersion,
          value: row.value,
          scope: answerFrom.get(input.name) ?? row.scope,
        },
      };
    },
  } as SecretBinding;
  const appended: AuditEvent[][] = [];
  /** Every batch the route tried to append, written or not. */
  const tried: AuditEvent[][] = [];
  const auditEvents =
    options.audit === undefined
      ? undefined
      : ({
          async append(batch: readonly AuditEvent[]) {
            tried.push([...batch]);
            if (options.audit === 'throws') throw new Error('the audit store is down');
            if (options.audit === 'refused') {
              return { kind: 'err', error: { code: 'persistence-error', message: 'refused' } };
            }
            appended.push([...batch]);
            return { kind: 'ok', value: undefined };
          },
        } as unknown as AuditEventBinding);
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
        return {
          tenantId: SYSTEM_TENANT_ID,
          system: { keyId: keyIdOf(token) },
          capabilities: scopes,
        };
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
    ...(options.secrets === true && { secretsBinding: secrets }),
    ...(auditEvents !== undefined && { auditEvents }),
    ...(options.logger !== undefined && { logger: options.logger }),
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
      headers: res.headers,
    };
  };
  return {
    call,
    deployments,
    servedList,
    recorded,
    setInputs,
    setEnv,
    applied,
    setSecret,
    secretFaults,
    answerFrom,
    resolved,
    appended,
    tried,
  };
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
  test('lists only a service running on values that changed: ids and the revision it runs', async () => {
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
          appliedRevision: oldRevision,
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
      held: { revision: heldRevision, code: 'pack-env-missing', since: NOW },
    });
    const r = await a.call(PACK_ENV, 'GET', '/v1/system/pack-env');
    expect(r.body.data).toEqual([
      expect.not.objectContaining({ appliedRevision: expect.anything() }),
    ]);
    expect((r.body.data as { deploymentId: string }[]).map((e) => e.deploymentId)).toEqual([
      'd-fresh',
    ]);
  });

  test("one whose revision didn't start is listed again for an hour after it was first held, then waits for a change", async () => {
    const a = makeApp();
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const rows: [string, string, string][] = [
      ['d-retry', 'pack-env-update-failed', ago(50)],
      ['d-done', 'pack-env-update-failed', ago(61)],
      ['d-missing', 'pack-env-missing', ago(1)],
    ];
    for (const [id, heldCode, since] of rows) {
      const d = deployment(id, prod, ready);
      a.deployments.set(id, d);
      const revision = (await a.call(PACK_ENV, 'GET', valuesPath(live, id))).body
        .revision as string;
      a.servedList.push({
        ...served(d, 'pe1-older'),
        held: { revision, code: heldCode as 'pack-env-missing', since },
      });
    }
    const r = await a.call(PACK_ENV, 'GET', '/v1/system/pack-env');
    expect((r.body.data as { deploymentId: string }[]).map((e) => e.deploymentId)).toEqual([
      'd-retry',
    ]);
    expect(r.body.data).toEqual([expect.objectContaining({ appliedRevision: 'pe1-older' })]);
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

  test("held as didn't start: the endpoint shows it, and its service keeps what it runs", async () => {
    const a = makeApp();
    a.deployments.set('d', deployment('d', staging, ready));
    await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), { revision: 'pe1-a' });
    const r = await a.call(PACK_ENV, 'PUT', valuesPath(live, 'd'), {
      revision: 'pe1-b',
      held: 'pack-env-update-failed',
      appliedRevision: 'pe1-a',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: 'ready',
      since: NOW,
      packEnvProblem: { code: 'pack-env-update-failed', since: NOW },
    });
    expect(a.applied.get('d')).toBe('pe1-a');
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

describe('GET …/pack-env?secrets=values: secret values, for the pack env key only', () => {
  const SENTINEL = 'sk-sentinel-7d1f0a9c-never-elsewhere';
  const withSecretPath = (d: string) => `${valuesPath(live, d)}?secrets=values`;
  const projectAt: Scope = { kind: 'project', tenantId: live, projectId: staging };

  /** A deployment declaring ACME_API_KEY, set only as a secret, and API_BASE, set as a plain value. */
  function withSecret(
    options: {
      readonly audit?: 'ok' | 'refused' | 'throws' | 'none';
      readonly logger?: Logger;
    } = {},
  ) {
    const audit = options.audit ?? 'ok';
    const a = makeApp({
      secrets: true,
      ...(audit !== 'none' && { audit }),
      ...(options.logger !== undefined && { logger: options.logger }),
    });
    a.deployments.set('d', {
      ...deployment('d', staging, ready),
      packEnv: { required: ['ACME_API_KEY', 'API_BASE'], optional: [] },
    });
    a.setEnv(projectAt, 'API_BASE', 'https://staging.acme.test');
    a.setSecret(projectAt, 'ACME_API_KEY', SENTINEL);
    return a;
  }

  test('gives it with its revision, audits it before the answer, and is never cached', async () => {
    const a = withSecret();
    const r = await a.call(PACK_ENV, 'GET', withSecretPath('d'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.body.problem).toBeUndefined();
    expect(r.body.env).toEqual({ API_BASE: 'https://staging.acme.test' });
    expect(r.body.secrets).toEqual({
      ACME_API_KEY: { value: SENTINEL, revision: expect.stringMatching(/^ps1-[0-9a-f]{64}$/) },
    });
    expect(r.body.names).toContainEqual({
      name: 'ACME_API_KEY',
      required: true,
      kind: 'secret',
      scope: { kind: 'project', id: staging },
      missing: false,
    });
    const rows = a.appended.flat().filter((e) => e.kind === 'secret-resolved');
    expect(rows).toHaveLength(1);
    // Who took it: the request (its id joins the system access record) and the key.
    const requestId = r.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    expect(rows[0]).toMatchObject({
      actor: 'system:d',
      tenantId: live,
      projectId: staging,
      correlationId: requestId,
      payload: {
        doc: {
          name: 'ACME_API_KEY',
          caller: 'pack-env',
          deploymentId: 'd',
          systemKeyId: keyIdOf(PACK_ENV),
          revision: (r.body.secrets as Record<string, { revision: string }>).ACME_API_KEY?.revision,
        },
      },
    });
    // The key by its id, never its token.
    expect(JSON.stringify(a.appended)).not.toContain(PACK_ENV);
    expect(a.resolved).toHaveLength(1);
  });

  test.each([
    [FULL, 'kindgi:system alone', 'system-scope-missing'],
    [ORCHESTRATOR, 'system:deployments', 'system-scope-missing'],
    [TENANT_KEY, "a tenant's key", 'system-principal-required'],
  ])(
    '%s (%s) asking for values: 403 %s, with nothing read and no row',
    async (token, _why, refusal) => {
      const a = withSecret();
      const r = await a.call(token, 'GET', withSecretPath('d'));
      expect(r.status).toBe(403);
      expect(code(r)).toBe(refusal);
      expect(r.text).not.toContain(SENTINEL);
      expect(a.resolved).toHaveLength(0);
      expect(a.appended).toHaveLength(0);
    },
  );

  test('a key holding system:pack-env itself, beside kindgi:system, is given them', async () => {
    const a = withSecret();
    const r = await a.call(FULL_AND_PACK_ENV, 'GET', withSecretPath('d'));
    expect(r.status).toBe(200);
    expect(r.body.secrets).toEqual({ ACME_API_KEY: expect.objectContaining({ value: SENTINEL }) });
  });

  test("kindgi:system without the ask: today's answer, the name secret-not-yet, nothing read", async () => {
    const a = withSecret();
    const r = await a.call(FULL, 'GET', valuesPath(live, 'd'));
    expect(r.status).toBe(200);
    expect(r.body.problem).toBe('pack-env-secret-not-yet');
    expect(r.body).not.toHaveProperty('secrets');
    expect(r.body).not.toHaveProperty('env');
    expect(a.resolved).toHaveLength(0);
  });

  test("without the ask, the answer is today's, byte for byte", async () => {
    const a = withSecret();
    const problem = await a.call(PACK_ENV, 'GET', valuesPath(live, 'd'));
    expect(problem.text).toBe(
      JSON.stringify({
        revision: problem.body.revision,
        names: [
          {
            name: 'ACME_API_KEY',
            required: true,
            kind: 'secret',
            scope: { kind: 'project', id: staging },
            missing: false,
            problem: 'secret-not-yet',
          },
          {
            name: 'API_BASE',
            required: true,
            kind: 'env',
            scope: { kind: 'project', id: staging },
            missing: false,
          },
        ],
        problem: 'pack-env-secret-not-yet',
      }),
    );
    a.deployments.set('d-plain', deployment('d-plain', staging, ready));
    const plain = await a.call(PACK_ENV, 'GET', valuesPath(live, 'd-plain'));
    expect(plain.text).toBe(
      JSON.stringify({
        revision: plain.body.revision,
        names: [
          {
            name: 'API_BASE',
            required: true,
            kind: 'env',
            scope: { kind: 'project', id: staging },
            missing: false,
          },
          { name: 'LOG_LEVEL', required: false, kind: null, scope: null, missing: true },
        ],
        env: { API_BASE: 'https://staging.acme.test' },
      }),
    );
    expect(a.resolved).toHaveLength(0);
    expect(a.appended.flat().filter((e) => e.kind === 'secret-resolved')).toHaveLength(0);
  });

  test.each([['yes'], ['VALUES'], ['']])('secrets=%s: 400, with nothing read', async (raw) => {
    const a = withSecret();
    const r = await a.call(PACK_ENV, 'GET', `${valuesPath(live, 'd')}?secrets=${raw}`);
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
    expect(a.resolved).toHaveLength(0);
  });

  test('a server with nowhere to audit them: 501 pack-env-secrets-unaudited, with nothing read', async () => {
    const a = withSecret({ audit: 'none' });
    const r = await a.call(PACK_ENV, 'GET', withSecretPath('d'));
    expect(r.status).toBe(501);
    expect(code(r)).toBe('pack-env-secrets-unaudited');
    expect(a.resolved).toHaveLength(0);
    // Without the ask, the same server answers as before.
    expect((await a.call(PACK_ENV, 'GET', valuesPath(live, 'd'))).body.problem).toBe(
      'pack-env-secret-not-yet',
    );
  });

  test.each([['refused'], ['throws']] as const)(
    'rows that can not be written (the append %s): 503 pack-env-unavailable, and no value',
    async (audit) => {
      const a = withSecret({ audit });
      const r = await a.call(PACK_ENV, 'GET', withSecretPath('d'));
      expect(r.status).toBe(503);
      expect(code(r)).toBe('pack-env-unavailable');
      expect(r.text).not.toContain(SENTINEL);
      expect(r.text).not.toContain('staging.acme.test');
      expect(a.tried).toHaveLength(1);
    },
  );

  test('a store that answers from another scope than asked: 200 pack-env-secret-unreadable, no value', async () => {
    const a = withSecret();
    a.answerFrom.set('ACME_API_KEY', { kind: 'tenant', tenantId: live });
    const r = await a.call(PACK_ENV, 'GET', withSecretPath('d'));
    expect(r.status).toBe(200);
    expect(r.body.problem).toBe('pack-env-secret-unreadable');
    expect(r.body).not.toHaveProperty('secrets');
    expect(r.text).not.toContain(SENTINEL);
    expect(a.tried).toHaveLength(0);
  });

  test('a store that is out: 503 pack-env-unavailable', async () => {
    const a = withSecret();
    a.secretFaults.set('ACME_API_KEY', 'secret-provider-unavailable');
    const r = await a.call(PACK_ENV, 'GET', withSecretPath('d'));
    expect(r.status).toBe(503);
    expect(code(r)).toBe('pack-env-unavailable');
    expect(r.text).not.toContain("the store's own words");
  });

  test("a secret the platform has to fix: 200 pack-env-secret-unreadable, no value, the store's words kept back", async () => {
    const a = withSecret();
    a.secretFaults.set('ACME_API_KEY', 'secret-decryption-failed');
    const r = await a.call(PACK_ENV, 'GET', withSecretPath('d'));
    expect(r.status).toBe(200);
    expect(r.body.problem).toBe('pack-env-secret-unreadable');
    expect(r.body.names).toContainEqual(
      expect.objectContaining({ name: 'ACME_API_KEY', kind: 'secret', problem: 'unreadable' }),
    );
    expect(r.body).not.toHaveProperty('secrets');
    expect(r.body).not.toHaveProperty('env');
    expect(r.text).not.toContain("the store's own words");
    expect(a.appended).toHaveLength(0);
  });

  test('the value is only ever in the answer: not in a log at any level, a row or a refusal', async () => {
    const lines: string[] = [];
    const record = (level: string) => (message: string, fields?: unknown, options?: unknown) =>
      lines.push(
        JSON.stringify({ level, message, fields, options }, (_k, v) =>
          v instanceof Error ? { message: v.message, stack: v.stack } : v,
        ),
      );
    const logger: Logger = {
      error: record('error'),
      warn: record('warn'),
      info: record('info'),
      debug: record('debug'),
      trace: record('trace'),
      child: () => logger,
      isLevelEnabled: () => true,
    };
    const a = withSecret({ logger });
    const given = await a.call(PACK_ENV, 'GET', withSecretPath('d'));
    expect(given.text).toContain(SENTINEL);
    const refusals = [
      await a.call(FULL, 'GET', withSecretPath('d')),
      await a.call(PACK_ENV, 'GET', `${valuesPath(live, 'd')}?secrets=nope`),
      await a.call(PACK_ENV, 'GET', valuesPath(live, 'd')),
    ];
    // Each of these reads the value, then gives none.
    const unwritten = [
      withSecret({ audit: 'refused', logger }),
      withSecret({ audit: 'throws', logger }),
    ];
    for (const b of unwritten) refusals.push(await b.call(PACK_ENV, 'GET', withSecretPath('d')));
    a.answerFrom.set('ACME_API_KEY', { kind: 'tenant', tenantId: live });
    refusals.push(await a.call(PACK_ENV, 'GET', withSecretPath('d')));
    a.answerFrom.delete('ACME_API_KEY');
    a.secretFaults.set('ACME_API_KEY', 'secret-decryption-failed');
    refusals.push(await a.call(PACK_ENV, 'GET', withSecretPath('d')));
    a.secretFaults.set('ACME_API_KEY', 'secret-store-error');
    refusals.push(await a.call(PACK_ENV, 'GET', withSecretPath('d')));
    // The append's failure (with its cause) and the other scope's are logged.
    expect(lines.filter((l) => l.includes('pack-env-secret-rows-unwritten'))).toHaveLength(2);
    expect(lines.some((l) => l.includes('the audit store is down'))).toBe(true);
    expect(lines.some((l) => l.includes('another scope than asked'))).toBe(true);
    expect(lines.join('\n')).not.toContain(SENTINEL);
    expect(JSON.stringify([a.tried, ...unwritten.map((b) => b.tried)])).not.toContain(SENTINEL);
    for (const r of refusals) {
      expect(r.text).not.toContain(SENTINEL);
      expect([...r.headers.values()].join('\n')).not.toContain(SENTINEL);
    }
    expect([...given.headers.values()].join('\n')).not.toContain(SENTINEL);
  });

  test("the owner's check: set as a secret, with no problem, and its value never read", async () => {
    const a = withSecret();
    const r = await a.call(TENANT_KEY, 'GET', '/v1/deployments/d/pack-env');
    expect(r.status).toBe(200);
    expect(r.body.problem).toBeUndefined();
    expect(r.body.data).toContainEqual({
      name: 'ACME_API_KEY',
      required: true,
      kind: 'secret',
      scope: { kind: 'project', id: staging },
      missing: false,
    });
    expect(r.body).not.toHaveProperty('secrets');
    expect(r.text).not.toContain(SENTINEL);
    expect(a.resolved).toHaveLength(0);
    // Its query is not the system route's: asking it for values reads none.
    const asked = await a.call(TENANT_KEY, 'GET', '/v1/deployments/d/pack-env?secrets=values');
    expect(asked.text).not.toContain(SENTINEL);
    expect(a.resolved).toHaveLength(0);
  });
});

describe('GET /v1/system/pack-env: a hold the platform fixes', () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  test('is listed every time at its revision, with its hold; an owner hold is not', async () => {
    const a = makeApp();
    const rows: [string, string, string][] = [
      ['d-unreadable', 'pack-env-secret-unreadable', ago(24 * 60)],
      ['d-unaudited', 'pack-env-secrets-unaudited', ago(61)],
      ['d-not-yet', 'pack-env-secret-not-yet', ago(1)],
      ['d-too-large', 'pack-env-secret-too-large', ago(1)],
      ['d-redeploy', 'pack-env-secret-redeploy', ago(1)],
      ['d-missing', 'pack-env-missing', ago(1)],
    ];
    for (const [id, heldCode, since] of rows) {
      const d = deployment(id, prod, ready);
      a.deployments.set(id, d);
      const revision = (await a.call(PACK_ENV, 'GET', valuesPath(live, id))).body
        .revision as string;
      a.servedList.push({
        ...served(d, 'pe1-older'),
        held: { revision, code: heldCode as 'pack-env-missing', since },
      });
    }
    for (let pass = 0; pass < 2; pass++) {
      const r = await a.call(PACK_ENV, 'GET', '/v1/system/pack-env');
      expect(r.body.data).toEqual([
        expect.objectContaining({
          deploymentId: 'd-unreadable',
          appliedRevision: 'pe1-older',
          held: { code: 'pack-env-secret-unreadable', since: rows[0]?.[2] },
        }),
        expect.objectContaining({
          deploymentId: 'd-unaudited',
          held: { code: 'pack-env-secrets-unaudited', since: rows[1]?.[2] },
        }),
      ]);
    }
  });

  test('held at an older revision: listed as a change, without its hold', async () => {
    const a = makeApp();
    const d = deployment('d', prod, ready);
    a.deployments.set('d', d);
    a.servedList.push({
      ...served(d, 'pe1-older'),
      held: { revision: 'pe1-older-still', code: 'pack-env-secret-unreadable', since: ago(5) },
    });
    const r = await a.call(PACK_ENV, 'GET', '/v1/system/pack-env');
    expect(r.body.data).toEqual([expect.objectContaining({ deploymentId: 'd' })]);
    expect(r.body.data).toEqual([expect.not.objectContaining({ held: expect.anything() })]);
  });

  test('a service retried after a revision that did not start carries no hold', async () => {
    const a = makeApp();
    const d = deployment('d', prod, ready);
    a.deployments.set('d', d);
    const revision = (await a.call(PACK_ENV, 'GET', valuesPath(live, 'd'))).body.revision as string;
    a.servedList.push({
      ...served(d, 'pe1-older'),
      held: { revision, code: 'pack-env-update-failed', since: ago(5) },
    });
    const r = await a.call(PACK_ENV, 'GET', '/v1/system/pack-env');
    expect(r.body.data).toEqual([expect.not.objectContaining({ held: expect.anything() })]);
  });
});
