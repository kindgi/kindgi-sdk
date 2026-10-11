// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import type { ApiTokenId, ProjectId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, encodeSessionToken } from '../src/index.js';
import type {
  IdentityProviderBinding,
  RunHandlerBinding,
  Session,
  SessionCreateInput,
  SessionStoreBinding,
  TokenAdmin,
  TokenResolver,
} from '../src/index.js';

/**
 * A session can carry an API key's limits (`SessionCreateInput.projectId`,
 * `role`), and is held to them as a key is: another project is refused,
 * and so is any action above its project, reading included, where a key
 * is refused only `admin` there. Such a session mints no keys and isn't
 * refreshed. A session without limits, and a key with them, keep today's
 * rules.
 */

const tenantId = randomUUID() as TenantId;
const P1 = randomUUID();
const P2 = randomUUID();
const EXPIRES = '2099-01-01T00:00:00.000Z' as Timestamp;
const LIMITED_KEY = 'kgi_ak_test_limited';
const RUN_IN_P1 = randomUUID();
const RUN_IN_P2 = randomUUID();

const noProviders: IdentityProviderBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
  unregister: async () => ({ unregistered: false }),
};

function makeApp() {
  const rows = new Map<string, Session>();
  const sessionStore: SessionStoreBinding = {
    async create(input: SessionCreateInput) {
      const id = randomUUID() as unknown as SessionId;
      rows.set(id, {
        id,
        tenantId: input.tenantId,
        userId: input.userId,
        providerId: input.providerId,
        expiresAt: input.expiresAt,
        scopes: input.scopes,
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.role !== undefined && { role: input.role }),
        createdAt: new Date().toISOString() as Timestamp,
      });
      return { sessionId: id, expiresAt: input.expiresAt };
    },
    get: async ({ sessionId }) => rows.get(sessionId) ?? null,
    list: async () => ({ data: [] }),
    revoke: async () => ({ revoked: true }),
    revokeAllForUser: async () => ({ revokedCount: 0 }),
  };

  // Everything is granted: what's refused below is the caller's own limit.
  // `inProject` answers for the two runs, so a route that takes only a
  // run's id is checked against the run's own project.
  const runProject: Record<string, string> = {
    [RUN_IN_P1]: P1,
    [RUN_IN_P2]: P2,
    'acme.agent-p1': P1,
    'acme.agent-p2': P2,
  };
  const asked: string[] = [];
  const authzCheckBinding: AuthzCheckBinding = {
    inProject: async (_principal, resource, projectId) => runProject[resource.id] === projectId,
    check: async (principal, action, resource) => {
      asked.push(`${action} ${resource.type}`);
      return {
        allowed: true,
        reason: 'test: granted',
        evidence: { action, relation: '', resource: resource.id, actorSubject: principal.actor.id },
      } satisfies Decision;
    },
    checkBatch: async () => [],
  };

  const minted: unknown[] = [];
  const tokenAdmin: TokenAdmin = {
    async mint(input) {
      minted.push(input);
      const tokenId = randomUUID() as ApiTokenId;
      return {
        record: {
          tokenId,
          ...(input.principal !== undefined && { principal: input.principal }),
          role: input.role,
          capabilities: input.capabilities,
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          createdAt: new Date(),
        },
        token: `kgi_ak_test_${minted.length}`,
      };
    },
    list: async () => [],
    get: async () => undefined,
    revoke: async () => ({ kind: 'not-found' }),
  };

  // A person's key limited to P1: today's rules for keys.
  const resolveToken: TokenResolver = async (token) =>
    token === LIMITED_KEY
      ? {
          tenantId,
          userId: 'jane' as UserId,
          tokenId: randomUUID() as ApiTokenId,
          tokenRole: 'member',
          tokenProjectId: P1,
          scopes: [],
        }
      : null;

  const stubs = createStubAppBindings();
  const run = (runId: string) => ({
    runId,
    tenantId,
    projectId: runProject[runId],
    flowId: 'acme.flow',
    flowVersion: '1.0.0',
    status: 'completed',
    input: {},
    dryRun: false,
    createdAt: EXPIRES,
    updatedAt: EXPIRES,
  });
  const app = createApp({
    ...stubs,
    kernelBinding: {
      ...stubs.kernelBinding,
      run: {
        ...stubs.kernelBinding.run,
        getRun: async (_tenant: TenantId, runId: string) =>
          runProject[runId] !== undefined ? run(runId) : null,
      } as never,
    },
    // No agent is registered: a caller let through gets a 404.
    agentRegistry: new Proxy({}, { get: () => async () => null }) as never,
    // Neither exists: a caller let through gets a 404, a caller held back a 403.
    orgBinding: { get: async () => undefined } as never,
    teamBinding: { get: async () => undefined } as never,
    teamMembershipBinding: {} as never,
    resolveToken,
    runHandler: {} as unknown as RunHandlerBinding,
    sessionStore,
    identityProvider: noProviders,
    tokenAdmin,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });

  const session = async (limits: Pick<SessionCreateInput, 'projectId' | 'role'> = {}) =>
    encodeSessionToken(
      (
        await sessionStore.create({
          tenantId,
          userId: 'jane' as UserId,
          providerId: 'site:acme-store',
          expiresAt: EXPIRES,
          scopes: [],
          ...limits,
        })
      ).sessionId,
    );

  const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as never };
  };
  return { call, session, asked, minted };
}

type ErrorBody = { error: { code: string; message: string } };
const limited = { projectId: P1 as ProjectId, role: 'member' as const };

describe('a session limited to a project', () => {
  test('reads nothing above its project, where a key limited the same way still reads', async () => {
    const h = makeApp();
    const open = await h.call(await h.session(), 'GET', '/v1/auth/providers');
    expect(open.status).toBe(200);

    const refused = await h.call(await h.session(limited), 'GET', '/v1/auth/providers');
    expect(refused.status).toBe(403);
    expect((refused.body as ErrorBody).error.message).toContain(
      `this session is limited to project ${P1}`,
    );

    expect((await h.call(LIMITED_KEY, 'GET', '/v1/auth/providers')).status).toBe(200);
  });

  test('is refused a request that names another project, and says it is a session', async () => {
    const h = makeApp();
    const res = await h.call(await h.session(limited), 'POST', '/v1/runs', {
      agent: 'acme.agent',
      input: {},
      projectId: P2,
    });
    expect(res.status).toBe(403);
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe('key-project-mismatch');
    expect(error.message).toBe(
      `This session is limited to project ${P1}; the request names project ${P2}`,
    );
  });

  test.each([
    ['an org', '/v1/orgs/acme-org'],
    ['a team', '/v1/teams/acme-team'],
  ])('reads not even %s, where a key limited the same way may', async (_what, path) => {
    const h = makeApp();
    const refused = await h.call(await h.session(limited), 'GET', path);
    expect(refused.status).toBe(403);
    expect((refused.body as ErrorBody).error.message).toContain('this session is limited');
    expect((await h.call(LIMITED_KEY, 'GET', path)).status).toBe(404);
  });

  test("reads a run in its own project by the run's id, and not one in another", async () => {
    const h = makeApp();
    const token = await h.session(limited);
    const own = await h.call(token, 'GET', `/v1/runs/${RUN_IN_P1}`);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: RUN_IN_P1, projectId: P1 });
    expect((await h.call(token, 'GET', `/v1/runs/${RUN_IN_P2}`)).status).toBe(403);
  });

  test("is asked about an agent's own project, by the agent's id", async () => {
    // An agent isn't a project, an org or a team: the store says which
    // project it's in (`inProject`), as it does for a key's limit.
    const h = makeApp();
    const token = await h.session(limited);
    expect((await h.call(token, 'GET', '/v1/agents/acme.agent-p1')).status).toBe(404);
    expect((await h.call(token, 'GET', '/v1/agents/acme.agent-p2')).status).toBe(403);
  });

  test('mints no key, even one limited to its own project', async () => {
    const h = makeApp();
    const res = await h.call(await h.session(limited), 'POST', '/v1/tokens', { projectId: P1 });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error.code).toBe('limited-session-cannot-mint');
    expect(h.minted).toEqual([]);

    // Nor does a session limited only by its role.
    const roleOnly = await h.call(await h.session({ role: 'member' }), 'POST', '/v1/tokens', {});
    expect(roleOnly.status).toBe(403);
    expect((roleOnly.body as ErrorBody).error.code).toBe('limited-session-cannot-mint');
    expect(h.minted).toEqual([]);

    // A session without limits mints its person's own key, as before.
    expect((await h.call(await h.session(), 'POST', '/v1/tokens', {})).status).toBe(201);
  });

  test('whoami says what it is limited to', async () => {
    const h = makeApp();
    const res = await h.call(await h.session(limited), 'GET', '/v1/identity/whoami');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: P1, role: 'member' });
  });
});
