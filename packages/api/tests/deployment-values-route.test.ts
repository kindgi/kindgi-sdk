// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/deployments/:deploymentId/values`: what a deployment needs set
 * in a project, names only. In its own project a value counts wherever
 * it's set; in another, a tool's secret counts only where the caller
 * administers, as their promotion would record it. It asks `admin` on the
 * project, as listing secrets there does, and never answers a value.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const OWN = randomUUID() as ProjectId;
const TARGET = randomUUID() as ProjectId;
const DEFAULT = randomUUID() as ProjectId;
const ORG = randomUUID() as OrgId;
const envName = 'prod' as EnvName;
/** Every stored value is this: no response may carry it. */
const SENTINEL = 'sentinel-acme-7f3a91c2';

const TOKEN = 'deployment-values-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

const TOOL = {
  id: 'acme.search',
  version: '1.0.0',
  needsSpec: {
    secrets: { ACME_TOKEN: { type: 'string' } },
    env: { ACME_REGION: { type: 'string' } },
  },
};
const SEARCH = { type: 'tool', id: 'acme.search', version: '1.0.0' };

const deployments: Record<string, object> = {
  'd-own': {
    deploymentId: 'd-own',
    tenantId,
    projectId: OWN,
    contents: {
      tools: [{ id: 'acme.search', version: '1.0.0' }],
      guardrails: [],
      agents: [{ id: 'acme.triage', version: '1.0.0' }],
      flows: [],
    },
  },
  'd-wide': {
    deploymentId: 'd-wide',
    tenantId,
    contents: {
      tools: [{ id: 'acme.search', version: '1.0.0' }],
      guardrails: [],
      agents: [],
      flows: [],
    },
  },
};

const scopeKey = (scope: Scope) =>
  scope.kind === 'project'
    ? `project:${scope.projectId}`
    : scope.kind === 'org'
      ? `org:${scope.orgId}`
      : 'tenant';

/**
 * `granted`: the pairs the caller holds, as `<action> <type>:<id>`, or
 * `<action> <type>` for every one of that type. `secrets` / `env`: where
 * each is set, as `<scope>/<name>` (`tenant/ACME_TOKEN`).
 */
function harness(opts: {
  granted: readonly string[];
  secrets?: readonly string[];
  env?: readonly string[];
  providers?: Record<string, string>;
  /** `false`: a runtime that records no projects (no project binding). */
  projectBinding?: false;
}) {
  const asked: string[] = [];
  const reads: string[] = [];
  const decide = (action: Action, resource: ResourceRef): Decision => {
    asked.push(`${action} ${resource.type}:${resource.id}`);
    const allowed =
      opts.granted.includes(`${action} ${resource.type}:${resource.id}`) ||
      opts.granted.includes(`${action} ${resource.type}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: no grant',
      evidence: {
        action,
        relation: '',
        resource: `${resource.type}:${resource.id}`,
        actorSubject: '',
      },
    };
  };
  const projects: Record<string, { id: ProjectId; orgId: OrgId }> = {
    [OWN]: { id: OWN, orgId: ORG },
    [TARGET]: { id: TARGET, orgId: ORG },
    [DEFAULT]: { id: DEFAULT, orgId: ORG },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    envName,
    deploymentRegistry: {
      get: async ({ deploymentId }: { deploymentId: string }) => deployments[deploymentId] ?? null,
    } as never,
    signingKeyRegistry: {} as never,
    imageRegistry: {} as never,
    projectBinding:
      opts.projectBinding === false
        ? undefined
        : ({
            get: async (_t: TenantId, id: ProjectId) => projects[id] ?? null,
            getDefault: async () => projects[DEFAULT],
          } as never),
    secretsBinding: {
      get: async ({ scope, name }: { scope: Scope; name: string }) => {
        reads.push(`secret ${scopeKey(scope)}/${name}`);
        return (opts.secrets ?? []).includes(`${scopeKey(scope).split(':')[0]}/${name}`)
          ? { name, value: SENTINEL, currentVersion: 1 }
          : null;
      },
    } as never,
    toolRegistry: {
      get: async () => null,
      getVersion: async ({ toolId, version }: { toolId: string; version: string }) =>
        toolId === TOOL.id && version === TOOL.version ? TOOL : null,
    } as never,
    agentRegistry: {
      getVersion: async ({ version }: { version: string }) =>
        version === '1.0.1'
          ? { id: 'acme.triage', version, preferredProvider: 'acme-llm' }
          : { id: 'acme.triage', version },
      listVersions: async () => ({
        data: [
          { version: '1.0.0' },
          { version: '1.0.1', derivedFrom: { reason: 'edited', version: '1.0.0' } },
        ],
      }),
    } as never,
    envBinding: {
      get: async ({ scope, name }: { scope: Scope; name: string }) =>
        (opts.env ?? []).includes(`${scopeKey(scope).split(':')[0]}/${name}`)
          ? { name, value: SENTINEL }
          : null,
    } as never,
    providerRegistry: {
      resolveForRuntime: async () =>
        Object.entries(opts.providers ?? {}).map(([id, key]) => ({
          metadata: { id },
          adapterId: id,
          secretRef: { envName: 'prod', name: key },
        })),
    } as never,
    deploymentValues: {
      packEnv: async () => [
        {
          name: 'ACME_PACK_URL',
          kind: 'pack-env',
          neededBy: { type: 'pack', id: 'acme-pack' },
          foundAt: 'project',
        },
      ],
    },
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, resource) => decide(action, resource),
        checkBatch: async (_p, action, resources) => resources.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  } as never);
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  return { get, asked, reads };
}

const READ = 'read tenant';

describe('the values a deployment needs in a project, names only', () => {
  test('its own project: each where a run finds it, a tenant-held secret too, for a caller who administers only the project', async () => {
    const h = harness({
      granted: [READ, `read project:${OWN}`, `admin project:${OWN}`],
      secrets: ['tenant/ACME_TOKEN'],
      env: ['project/ACME_REGION'],
    });
    const out = await h.get('/v1/deployments/d-own/values');
    expect(out.status, out.text).toBe(200);
    expect(out.body.data).toEqual([
      { name: 'ACME_TOKEN', kind: 'secret', neededBy: SEARCH, foundAt: 'tenant' },
      { name: 'ACME_REGION', kind: 'env', neededBy: SEARCH, foundAt: 'project' },
      // No provider is registered, so each agent version, shipped or carried, has none to call.
      {
        name: 'any provider',
        kind: 'model-key',
        neededBy: { type: 'agent', id: 'acme.triage', version: '1.0.0' },
        problem: 'no-provider',
      },
      {
        name: 'any provider',
        kind: 'model-key',
        neededBy: { type: 'agent', id: 'acme.triage', version: '1.0.1' },
        problem: 'no-provider',
      },
      {
        name: 'ACME_PACK_URL',
        kind: 'pack-env',
        neededBy: { type: 'pack', id: 'acme-pack' },
        foundAt: 'project',
      },
    ]);
    expect(h.asked).toContain(`admin project:${OWN}`);
  });

  test('`?projectId=` naming its own project is the same', async () => {
    const h = harness({
      granted: [READ, `read project:${OWN}`, `admin project:${OWN}`],
      secrets: ['tenant/ACME_TOKEN'],
    });
    const out = await h.get(`/v1/deployments/d-own/values?projectId=${OWN}`);
    expect(out.status, out.text).toBe(200);
    expect((out.body.data as object[])[0]).toEqual({
      name: 'ACME_TOKEN',
      kind: 'secret',
      neededBy: SEARCH,
      foundAt: 'tenant',
    });
  });

  test("another project: a tool's secret as the caller's promotion would record it", async () => {
    const projectOnly = harness({
      granted: [READ, `read project:${OWN}`, `admin project:${TARGET}`],
      secrets: ['tenant/ACME_TOKEN'],
    });
    const missing = await projectOnly.get(`/v1/deployments/d-own/values?projectId=${TARGET}`);
    expect(missing.status, missing.text).toBe(200);
    expect((missing.body.data as object[])[0]).toEqual({
      name: 'ACME_TOKEN',
      kind: 'secret',
      neededBy: SEARCH,
      problem: 'missing',
    });
    const tenantAdmin = harness({
      granted: [READ, `read project:${OWN}`, `admin project:${TARGET}`, `admin tenant:${tenantId}`],
      secrets: ['tenant/ACME_TOKEN'],
    });
    const found = await tenantAdmin.get(`/v1/deployments/d-own/values?projectId=${TARGET}`);
    expect((found.body.data as object[])[0]).toEqual({
      name: 'ACME_TOKEN',
      kind: 'secret',
      neededBy: SEARCH,
      foundAt: 'tenant',
    });
  });

  test('a tenant-wide deployment: its own project is the default project', async () => {
    const h = harness({
      granted: [READ, `read project:${DEFAULT}`, `admin project:${DEFAULT}`],
      secrets: ['tenant/ACME_TOKEN'],
    });
    const out = await h.get('/v1/deployments/d-wide/values');
    expect(out.status, out.text).toBe(200);
    expect((out.body.data as object[])[0]).toEqual({
      name: 'ACME_TOKEN',
      kind: 'secret',
      neededBy: SEARCH,
      foundAt: 'tenant',
    });
    expect(h.asked).toContain(`admin project:${DEFAULT}`);
  });

  test("a carried version's model key is listed too", async () => {
    const h = harness({
      granted: [READ, `read project:${OWN}`, `admin project:${OWN}`],
      providers: { 'acme-llm': 'ACME_LLM_KEY', 'acme-other': 'ACME_OTHER_KEY' },
      secrets: ['tenant/ACME_OTHER_KEY'],
    });
    const out = await h.get('/v1/deployments/d-own/values');
    expect(out.status, out.text).toBe(200);
    expect(out.body.data).toContainEqual({
      name: 'ACME_LLM_KEY',
      kind: 'model-key',
      neededBy: { type: 'provider', id: 'acme-llm' },
      problem: 'missing',
    });
  });

  test('never a value: no response carries one, and each entry has only its fields', async () => {
    const h = harness({
      granted: [READ, `read project:${OWN}`, `admin project:${OWN}`],
      secrets: ['tenant/ACME_TOKEN', 'tenant/ACME_LLM_KEY'],
      env: ['project/ACME_REGION'],
      providers: { 'acme-llm': 'ACME_LLM_KEY' },
    });
    const out = await h.get('/v1/deployments/d-own/values');
    expect(out.status, out.text).toBe(200);
    expect(out.text).not.toContain(SENTINEL);
    for (const entry of out.body.data as Record<string, unknown>[]) {
      expect(
        Object.keys(entry).every((k) =>
          ['name', 'kind', 'neededBy', 'foundAt', 'problem'].includes(k),
        ),
      ).toBe(true);
    }
  });
});

describe('who may read them', () => {
  test('without `admin` on the project: refused, and nothing is read', async () => {
    const h = harness({ granted: [READ, `read project:${OWN}`], secrets: ['tenant/ACME_TOKEN'] });
    const out = await h.get('/v1/deployments/d-own/values');
    expect(out.status).toBe(403);
    expect(h.reads).toEqual([]);
    const target = await h.get(`/v1/deployments/d-own/values?projectId=${TARGET}`);
    expect(target.status).toBe(403);
    expect(h.asked).toContain(`admin project:${TARGET}`);
    expect(h.reads).toEqual([]);
  });

  test('without `read` on the tenant: refused, as every deployments route is', async () => {
    const h = harness({ granted: [`admin project:${OWN}`] });
    const out = await h.get('/v1/deployments/d-own/values');
    expect(out.status).toBe(403);
    expect(h.asked).toEqual([`read tenant:${tenantId}`]);
  });

  test("without `read` on the deployment's own project: as an unknown one, a 404, and nothing is read", async () => {
    const h = harness({
      granted: [READ, `admin project:${TARGET}`],
      secrets: ['tenant/ACME_TOKEN'],
    });
    for (const path of [
      '/v1/deployments/d-own/values',
      `/v1/deployments/d-own/values?projectId=${TARGET}`,
    ]) {
      const out = await h.get(path);
      expect(out.status, path).toBe(404);
      expect(out.body.error, path).toMatchObject({
        code: 'deployment-not-found',
        message: 'No deployment with id "d-own" under this tenant',
      });
    }
    expect(h.asked).toContain(`read project:${OWN}`);
    expect(h.reads).toEqual([]);
  });

  test('an unknown deployment, a project of no one, a projectId that is not one', async () => {
    const h = harness({ granted: [READ, 'read project', 'admin project'] });
    const none = await h.get('/v1/deployments/d-none/values');
    expect(none.status).toBe(404);
    expect((none.body.error as { code: string }).code).toBe('deployment-not-found');
    const elsewhere = await h.get(`/v1/deployments/d-own/values?projectId=${randomUUID()}`);
    expect(elsewhere.status).toBe(404);
    expect((elsewhere.body.error as { code: string }).code).toBe('project-not-found');
    const bad = await h.get('/v1/deployments/d-own/values?projectId=staging-2');
    expect(bad.status).toBe(400);
    expect((bad.body.error as { code: string }).code).toBe('bad-input');
    expect(h.reads).toEqual([]);
  });

  test('a tenant-wide deployment on a runtime that records no projects: `projectId` is required', async () => {
    const h = harness({ granted: [READ, 'admin project'], projectBinding: false });
    const out = await h.get('/v1/deployments/d-wide/values');
    expect(out.status).toBe(400);
    const error = out.body.error as { code: string; message: string };
    expect(error.code).toBe('bad-input');
    expect(error.message).toContain('`projectId` is required');
    expect(h.reads).toEqual([]);
    const named = await h.get(`/v1/deployments/d-wide/values?projectId=${TARGET}`);
    expect(named.status).toBe(200);
  });
});
