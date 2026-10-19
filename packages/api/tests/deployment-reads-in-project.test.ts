// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A deployment is read in the project it serves (`readableDeployment`):
 * the one it names, else the tenant's Default, which a deployment stores
 * either way (the Default's id, or none). The list keeps the rows whose
 * project the caller reads; one deployment's routes answer one they don't
 * read as one that isn't there; a secrets sync asks `admin` on the scope
 * it writes. Without an authorizer nothing is asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { Cursor, ProjectId, SigningKeyId, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  Deployment,
  DeploymentBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const A = randomUUID() as ProjectId;
const B = randomUUID() as ProjectId;
const DEFAULT = randomUUID() as ProjectId;

type Role = 'viewer' | 'editor' | 'admin';
/** Each caller's roles, by token: every one is a member of the tenant. */
const CALLERS: Readonly<
  Record<string, { readonly tenantAdmin?: true; readonly projects?: Record<string, Role> }>
> = {
  admin: { tenantAdmin: true },
  nobody: {},
  viewerA: { projects: { [A]: 'viewer' } },
  editorB: { projects: { [B]: 'editor' } },
  adminB: { projects: { [B]: 'admin' } },
  viewerDefault: { projects: { [DEFAULT]: 'viewer' } },
};

/** The tenant's projects: a tenant admin is admin on these, and on no other id. */
const PROJECTS: readonly string[] = [A, B, DEFAULT];

/**
 * The authorization model's answer: the tenant's `read` is a member's,
 * its `admin` an admin's; on a project, a tenant admin is its admin (from
 * its parent, so not on one that isn't there), and `admin` includes
 * `write` (an editor's), which includes `read` (a viewer's).
 */
function decide(user: string, action: Action, resource: ResourceRef): Decision {
  const caller = CALLERS[user] ?? {};
  const role: Role | undefined =
    caller.tenantAdmin === true
      ? PROJECTS.includes(resource.id)
        ? 'admin'
        : undefined
      : caller.projects?.[resource.id];
  const allowed =
    resource.type === 'tenant'
      ? resource.id === tenantId && (action === 'read' || caller.tenantAdmin === true)
      : resource.type === 'project' &&
        role !== undefined &&
        (action === 'read' ||
          (action === 'write' && role !== 'viewer') ||
          (action === 'admin' && role === 'admin'));
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

const resolveToken: TokenResolver = async (token) =>
  token in CALLERS ? { tenantId, userId: token as UserId, capabilities: ['secrets:write'] } : null;

let minute = 0;
function deployment(id: string, projectId?: ProjectId): Deployment {
  minute += 1;
  const imageDigest = `sha256:${'0'.repeat(63)}${minute}`;
  return {
    deploymentId: id,
    tenantId,
    imageRef: `registry.acme.example/acme/pack@${imageDigest}`,
    imageDigest,
    artifactVersion: '20261018.1',
    indexHash: `sha256:${'1'.repeat(64)}`,
    signerKeyId: 'acme-release' as SigningKeyId,
    signerPublicKey: 'not-checked-here',
    signature: 'not-checked-here',
    publishedAt: '2026-10-18T09:00:00.000Z',
    activatedAt: new Date(Date.UTC(2026, 9, 18, 10, minute)).toISOString(),
    ...(projectId !== undefined && { projectId }),
    packId: 'acme.pack',
    primitives: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
    contents: { tools: [], guardrails: [], agents: [], flows: [] },
  };
}

/** Oldest first: the list answers newest first, so `d-a` comes last. */
const ROWS = [
  deployment('d-a', A),
  deployment('d-b', B),
  deployment('d-none'),
  deployment('d-default', DEFAULT),
];

/** `ignoresProject`: a binding that lists every row whatever `projectId` it's given. */
function registry(ignoresProject = false): DeploymentBinding {
  const notAsked = async (): Promise<never> => {
    throw new Error('not asked in these tests');
  };
  return {
    register: notAsked,
    getByImageDigest: notAsked,
    get: async ({ deploymentId }) => ROWS.find((d) => d.deploymentId === deploymentId) ?? null,
    async list({ limit, cursor, projectId }) {
      const listed = ROWS.filter(
        (d) =>
          ignoresProject ||
          projectId === undefined ||
          d.projectId === projectId ||
          (projectId === DEFAULT && d.projectId === undefined),
      ).sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));
      const from = cursor === undefined ? 0 : Number(cursor);
      return {
        data: listed.slice(from, from + limit),
        ...(from + limit < listed.length && { nextCursor: String(from + limit) as Cursor }),
      };
    },
  } as DeploymentBinding;
}

function harness(
  opts: {
    readonly authorizer?: false;
    readonly packEnvServed?: false;
    readonly ignoresProject?: true;
  } = {},
) {
  const asked: string[] = [];
  /** Each secret written, as `<scope kind> <name>`. */
  const written: string[] = [];
  const check = (principal: unknown, action: Action, resource: ResourceRef) => {
    asked.push(`${action} ${resource.type}:${resource.id}`);
    return decide((principal as { actor: { id: string } }).actor.id, action, resource);
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    envName: 'prod' as never,
    deploymentRegistry: registry(opts.ignoresProject === true),
    signingKeyRegistry: {} as never,
    imageRegistry: {} as never,
    projectBinding: {
      get: async (_t: TenantId, id: ProjectId) =>
        [A, B, DEFAULT].includes(id) ? { id, tenantId } : null,
      getDefault: async () => ({ id: DEFAULT, tenantId }),
    } as never,
    secretsBinding: {
      get: async () => null,
      set: async (input: { scope: { kind: string }; name: string }) => {
        written.push(`${input.scope.kind} ${input.name}`);
        return { kind: 'ok', versionId: 1 };
      },
    } as never,
    envBinding: { get: async () => null } as never,
    ...(opts.packEnvServed !== false && {
      systemDeployments: { binding: {} as never, endpointHostAllowed: () => false },
    }),
    ...(opts.authorizer !== false && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (p, action, resource) => check(p, action, resource),
          checkBatch: async (p, action, resources) =>
            resources.map((resource) => check(p, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  } as never);
  const call = async (caller: string, path: string, body?: unknown) => {
    asked.length = 0;
    written.length = 0;
    const res = await app.request(path, {
      ...(body !== undefined && {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      headers: {
        authorization: `Bearer ${caller}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  const listed = async (caller: string, query = '') => {
    const out = await call(caller, `/v1/deployments${query}`);
    expect(out.status, out.text).toBe(200);
    return (out.body.data as { deploymentId: string }[]).map((d) => d.deploymentId).sort();
  };
  return { call, listed, asked, written };
}

/** A secrets sync of one value: a refusal writes nothing. */
const SYNC = { envName: 'prod', secrets: [{ name: 'ACME_API_KEY', value: 'not-a-real-key' }] };
const SYNCED = {
  resolved: 0,
  added: 1,
  references: [{ name: 'ACME_API_KEY', ref: 'secret:prod/ACME_API_KEY#1', version: 1 }],
};

/**
 * A refusal the route returned: its body, not only the status, which the
 * refusal sets on the context however the route answers.
 */
function expectRefused(out: { status: number; body: Record<string, any> }, who: string): void {
  expect(out.status, who).toBe(403);
  expect(out.body.error?.code, who).toBe('permission-denied');
  expect(out.body.data, who).toBeUndefined();
  expect(out.body.resolved, who).toBeUndefined();
}

const notFound = (id: string) => ({
  code: 'deployment-not-found',
  message: `No deployment with id "${id}" under this tenant`,
});

describe('GET /v1/deployments: the rows whose project the caller reads', () => {
  test('each caller lists its projects’ deployments, the Default’s in both stored forms', async () => {
    const h = harness();
    expect(await h.listed('admin')).toEqual(['d-a', 'd-b', 'd-default', 'd-none']);
    expect(await h.listed('viewerA')).toEqual(['d-a']);
    expect(await h.listed('adminB')).toEqual(['d-b']);
    expect(await h.listed('viewerDefault')).toEqual(['d-default', 'd-none']);
    expect(await h.listed('nobody')).toEqual([]);
  });

  test('a page keeps only what the caller reads, so it can come back short, its cursor still the next one', async () => {
    const h = harness();
    const first = await h.call('viewerA', '/v1/deployments?limit=2');
    expect(first.body).toMatchObject({ data: [], hasMore: true, nextCursor: '2' });
    const next = await h.call('viewerA', '/v1/deployments?limit=2&cursor=2');
    expect(next.body.data.map((d: { deploymentId: string }) => d.deploymentId)).toEqual(['d-a']);
    expect(next.body.hasMore).toBe(false);
  });

  test('`?projectId=` needs `read` on that project: 403 without it, and then every row is theirs', async () => {
    const h = harness();
    expect(await h.listed('viewerA', `?projectId=${A}`)).toEqual(['d-a']);
    expect(await h.listed('viewerDefault', `?projectId=${DEFAULT}`)).toEqual([
      'd-default',
      'd-none',
    ]);
    expect(await h.listed('admin', `?projectId=${B}`)).toEqual(['d-b']);
    expectRefused(await h.call('viewerA', `/v1/deployments?projectId=${B}`), 'viewerA');
    expect(h.asked).toEqual([`read tenant:${tenantId}`, `read project:${B}`]);
  });

  test('`?projectId=` naming a project that isn’t there: 403, the tenant admin’s too, so it tells no one what exists', async () => {
    const h = harness();
    for (const caller of ['admin', 'viewerA']) {
      expectRefused(await h.call(caller, `/v1/deployments?projectId=${randomUUID()}`), caller);
    }
  });

  test('`?projectId=` keeps only what the caller reads, whatever the binding returns', async () => {
    const h = harness({ ignoresProject: true });
    expect(await h.listed('viewerA', `?projectId=${A}`)).toEqual(['d-a']);
    expect(await h.listed('viewerDefault', `?projectId=${DEFAULT}`)).toEqual([
      'd-default',
      'd-none',
    ]);
  });
});

describe('one deployment: one the caller does not read answers as one that is not there', () => {
  test('its record', async () => {
    const h = harness();
    expect((await h.call('viewerA', '/v1/deployments/d-a')).status).toBe(200);
    expect((await h.call('viewerDefault', '/v1/deployments/d-none')).status).toBe(200);
    expect((await h.call('viewerDefault', '/v1/deployments/d-default')).status).toBe(200);
    expect((await h.call('admin', '/v1/deployments/d-b')).status).toBe(200);
    for (const [caller, id] of [
      ['viewerA', 'd-b'],
      ['viewerA', 'd-none'],
      ['nobody', 'd-a'],
      ['nobody', 'd-none'],
      ['nobody', 'd-default'],
      ['viewerA', 'd-unknown'],
    ] as const) {
      const out = await h.call(caller, `/v1/deployments/${id}`);
      expect(out.status, `${caller} ${id}`).toBe(404);
      expect(out.body.error, `${caller} ${id}`).toMatchObject(notFound(id));
    }
  });

  test('its pack env, where the server serves it', async () => {
    const h = harness();
    expect((await h.call('viewerA', '/v1/deployments/d-a/pack-env')).status).toBe(200);
    expect((await h.call('admin', '/v1/deployments/d-b/pack-env')).status).toBe(200);
    for (const caller of ['viewerA', 'nobody']) {
      const out = await h.call(caller, '/v1/deployments/d-b/pack-env');
      expect(out.status, caller).toBe(404);
      expect(out.body.error, caller).toMatchObject(notFound('d-b'));
    }
  });

  test('where the server does not serve pack env: 501 to every caller, before the deployment is read', async () => {
    const h = harness({ packEnvServed: false });
    for (const caller of ['admin', 'viewerA', 'nobody']) {
      const out = await h.call(caller, '/v1/deployments/d-b/pack-env');
      expect(out.status, caller).toBe(501);
      expect(out.body.error.code, caller).toBe('pack-env-not-served');
      expect(h.asked, caller).toEqual([`read tenant:${tenantId}`]);
    }
  });
});

describe('POST /v1/deployments/{id}/secrets: the deployment’s read, then `admin` on the scope it writes', () => {
  test('a project admin syncs into their project; an editor there is refused', async () => {
    const h = harness();
    const synced = await h.call('adminB', '/v1/deployments/d-b/secrets', SYNC);
    expect(synced.status, synced.text).toBe(200);
    expect(synced.body).toEqual(SYNCED);
    expect(h.written).toEqual(['project ACME_API_KEY']);
    expectRefused(await h.call('editorB', '/v1/deployments/d-b/secrets', SYNC), 'editorB');
    expect(h.asked).toEqual([`read project:${B}`, `admin project:${B}`]);
    expect(h.written).toEqual([]);
  });

  test('a deployment the caller does not read: 404, as one that is not there', async () => {
    const h = harness();
    for (const caller of ['viewerA', 'nobody']) {
      const out = await h.call(caller, '/v1/deployments/d-b/secrets', SYNC);
      expect(out.status, caller).toBe(404);
      expect(out.body.error, caller).toMatchObject(notFound('d-b'));
      expect(h.written, caller).toEqual([]);
    }
  });

  test('a tenant-wide deployment writes tenant-wide: the tenant’s admin, not the Default’s reader', async () => {
    const h = harness();
    const viewer = await h.call('viewerDefault', '/v1/deployments/d-none/secrets', SYNC);
    expectRefused(viewer, 'viewerDefault');
    expect(h.asked).toEqual([`read project:${DEFAULT}`, `admin tenant:${tenantId}`]);
    expect(h.written).toEqual([]);
    const admin = await h.call('admin', '/v1/deployments/d-none/secrets', SYNC);
    expect(admin.body).toEqual(SYNCED);
    expect(h.written).toEqual(['tenant ACME_API_KEY']);
  });
});

describe('without an authorizer', () => {
  test('every caller in the tenant reads every deployment, and syncs its secrets', async () => {
    const h = harness({ authorizer: false });
    expect(await h.listed('nobody')).toEqual(['d-a', 'd-b', 'd-default', 'd-none']);
    expect((await h.call('nobody', '/v1/deployments/d-b')).status).toBe(200);
    expect((await h.call('nobody', '/v1/deployments/d-b/pack-env')).status).toBe(200);
    expect((await h.call('nobody', '/v1/deployments/d-b/secrets', SYNC)).status).toBe(200);
  });
});
