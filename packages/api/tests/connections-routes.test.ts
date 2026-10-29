// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The connections routes over an in-memory binding: who reaches what, what
 * each route checks before the binding, and what it passes on.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { AppEntry, SignIn } from '@kindgi/connections';
import { github } from '@kindgi/connections/github';
import { google } from '@kindgi/connections/google';
import { microsoft } from '@kindgi/connections/microsoft';
import type { EnvName, TenantId, UserId } from '@kindgi/types';

import type {
  ConnectRequestRecord,
  ConnectionAppRecord,
  ConnectionBinding,
  ConnectionRecord,
} from '../src/connection-binding.js';
import type { HitlBinding } from '../src/hitl-binding.js';
import { createApp } from '../src/index.js';
import type { ReviewerBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const ANA = 'user-ana';
const BEN = 'user-ben';
const ADMIN = 'user-admin';
const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  ana: { tenantId: tenantA, userId: ANA as UserId },
  ben: { tenantId: tenantA, userId: BEN as UserId },
  admin: { tenantId: tenantA, userId: ADMIN as UserId, scopes: ['tenant-admin'] },
  /** The admin's `member` key: no admin action through it. */
  'admin-member-key': {
    tenantId: tenantA,
    userId: ADMIN as UserId,
    scopes: ['tenant-admin'],
    tokenRole: 'member',
  },
  bot: { tenantId: tenantA, serviceAccountId: 'sa-bot' },
  other: { tenantId: tenantB, userId: 'user-other' as UserId, scopes: ['tenant-admin'] },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;
const SECRET = { envName: 'local', name: 'ACME_GOOGLE_CLIENT_SECRET' };
const at = '2026-10-22T12:00:00.000Z';

/** A binding that keeps everything in maps, and records what the routes pass it. */
function memoryBinding(entries: readonly AppEntry[] = [google, github]) {
  const apps = new Map<string, ConnectionAppRecord>();
  const connections = new Map<string, ConnectionRecord>();
  const requests = new Map<string, ConnectRequestRecord>();
  const calls: Record<string, unknown[]> = {};
  const seen = (name: string, input: unknown) => {
    calls[name] = [...(calls[name] ?? []), input];
  };
  const refuse = (code: string, message: string, field?: string) => ({
    kind: 'err' as const,
    error: { code, message, ...(field !== undefined && { field }) } as never,
  });
  const binding: ConnectionBinding = {
    entries: () => entries,
    async listApps(input) {
      seen('listApps', input);
      return {
        data: [...apps.values()].filter(
          (a) =>
            a.tenantId === input.tenantId &&
            (input.includeRemoved === true || a.removedAt === undefined),
        ),
      };
    },
    async getApp({ tenantId, appId }) {
      const app = apps.get(appId);
      return app?.tenantId === tenantId ? app : null;
    },
    async createApp(input) {
      seen('createApp', input);
      if (input.app !== 'google' && input.app !== 'github' && input.app !== 'microsoft') {
        return refuse('connection-app-unknown-entry', `No entry "${input.app}"`);
      }
      const appId = randomUUID();
      const record: ConnectionAppRecord = {
        appId,
        tenantId: input.tenantId,
        app: input.app,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.oauth2 !== undefined && { oauth2: input.oauth2 }),
        ...(input.projects !== undefined && { projects: input.projects }),
        redirectUrl: 'https://kindgi.acme.example/console/connect/callback',
        noticesUrl: `https://kindgi.acme.example/v1/connection-notices/${input.tenantId}/${appId}`,
        createdAt: at,
        updatedAt: at,
      };
      apps.set(appId, record);
      return { kind: 'ok', value: record };
    },
    async updateApp(input) {
      seen('updateApp', input);
      const app = apps.get(input.appId);
      if (app === undefined) return refuse('connection-app-not-found', 'no app');
      return {
        kind: 'ok',
        value: { ...app, ...(input.label !== undefined && { label: input.label }) },
      };
    },
    async removeApp(input) {
      seen('removeApp', input);
      return { kind: 'ok', value: { connectionsRemoved: input.withConnections ? 2 : 0 } };
    },
    async list(input) {
      seen('list', input);
      const data = [...connections.values()].filter(
        (c) =>
          c.tenantId === input.tenantId &&
          (input.ownerUserId === undefined ||
            (c.owner.kind === 'member' && c.owner.userId === input.ownerUserId)) &&
          (input.ownerKind === undefined || c.owner.kind === input.ownerKind),
      );
      return { data };
    },
    async get({ tenantId, connectionId }) {
      const connection = connections.get(connectionId);
      return connection?.tenantId === tenantId ? connection : null;
    },
    async disconnect(input) {
      seen('disconnect', input);
      const connection = connections.get(input.connectionId) as ConnectionRecord;
      const removed: ConnectionRecord = {
        ...connection,
        state: 'removed',
        removedAt: at,
        removedReason: 'disconnected',
        withdrawn: 'at-app',
      };
      connections.set(input.connectionId, removed);
      return { kind: 'ok', value: removed };
    },
    async createRequest(input) {
      seen('createRequest', input);
      if (input.permissions.some((p) => !(p in google.permissions))) {
        return refuse('bad-input', 'Google has no such permission', 'permissions');
      }
      const requestId = randomUUID();
      const record: ConnectRequestRecord = {
        requestId,
        tenantId: input.tenantId,
        envName: input.envName,
        appId: randomUUID(),
        app: input.app,
        owner: input.owner,
        permissions: input.permissions,
        says: input.permissions.map((p) => google.permissions[p]?.says ?? p),
        state: 'pending',
        connectUrl: `https://kindgi.acme.example/console/connect/requests/${requestId}`,
        expiresAt: '2026-10-22T13:00:00.000Z',
        createdAt: at,
        createdBy: `${input.by.kind}:${input.by.id}`,
      };
      requests.set(requestId, record);
      return { kind: 'ok', value: record };
    },
    async getRequest({ tenantId, requestId }) {
      const request = requests.get(requestId);
      return request?.tenantId === tenantId ? request : null;
    },
    async requestsForRun() {
      return [];
    },
    async startRequest(input) {
      seen('startRequest', input);
      const request = requests.get(input.requestId) as ConnectRequestRecord;
      requests.set(input.requestId, {
        ...request,
        startedBy: `${input.caller.kind}:${input.caller.id}`,
      });
      return {
        kind: 'ok',
        value: { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s-1' },
      };
    },
    async finishRequest(input) {
      seen('finishRequest', input);
      const request = [...requests.values()].find((r) => r.startedBy !== undefined);
      if (request === undefined) return refuse('connection-state-expired', 'start again');
      if (request.startedBy !== `${input.caller.kind}:${input.caller.id}`) {
        return refuse('connection-not-yours', 'Only whoever started it finishes it');
      }
      if (input.code === 'several') {
        const installations = [
          { installationId: '101', account: { id: '1', label: 'acme' } },
          { installationId: '102', account: { id: '2', label: 'acme-labs' } },
        ];
        const pending = { ...request, installations };
        requests.set(request.requestId, pending);
        return { kind: 'ok', value: { kind: 'pick-installation', request: pending } };
      }
      if (input.code === 'unreachable') {
        return {
          kind: 'err',
          error: {
            code: 'connection-installation-unreachable',
            message: "Your GitHub account doesn't reach an installation of the app",
            connectRequestId: request.requestId,
          },
        };
      }
      const connection = connectionOf(request.owner);
      connections.set(connection.connectionId, connection);
      return {
        kind: 'ok',
        value: {
          kind: 'connected',
          request: { ...request, state: 'connected', connectionId: connection.connectionId },
          connection,
        },
      };
    },
    async receiveNotice(input) {
      seen('receiveNotice', input);
      const signature = input.headers['x-acme-signature'];
      if (signature === 'good')
        return { kind: 'ok', value: { handled: 'removed', connections: 1 } };
      if (signature === 'store-down') {
        return refuse('connection-store-failed', 'the store is down');
      }
      return refuse('connection-notice-invalid', 'the signature does not match');
    },
  };

  function connectionOf(owner: ConnectionRecord['owner']): ConnectionRecord {
    return {
      connectionId: randomUUID(),
      tenantId: tenantA,
      envName: 'local' as EnvName,
      appId: randomUUID(),
      app: 'google',
      owner,
      account: {
        id: '1234',
        label: owner.kind === 'member' ? `${owner.userId}@acme.example` : 'acme',
      },
      permissions: ['gmail.send'],
      state: 'working',
      connectedAt: at,
      createdAt: at,
      createdBy: owner.kind === 'member' ? `user:${owner.userId}` : `user:${ADMIN}`,
      updatedAt: at,
    };
  }

  /** A stored connection, as a finished connect would leave it. */
  function connected(
    owner: ConnectionRecord['owner'],
    tenantId = tenantA,
    more: Partial<ConnectionRecord> = {},
  ): ConnectionRecord {
    const connection = { ...connectionOf(owner), tenantId, ...more };
    connections.set(connection.connectionId, connection);
    return connection;
  }

  return { binding, calls, connected, requests };
}

const runHandler = {} as RunHandlerBinding;

function makeApp(
  options: {
    reviewers?: ReviewerBinding;
    clientAddress?: (r: Request) => string | undefined;
    authzCheckBinding?: AuthzCheckBinding;
    entries?: readonly AppEntry[];
  } = {},
) {
  const memory = memoryBinding(options.entries);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    envName: 'local' as EnvName,
    connections: memory.binding,
    ...(options.reviewers !== undefined && {
      reviewerBinding: options.reviewers,
      hitlBinding: {} as HitlBinding,
    }),
    ...(options.authzCheckBinding !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: options.authzCheckBinding },
    }),
  });
  return { app, ...memory };
}

type App = ReturnType<typeof makeApp>['app'];

async function call(
  app: App,
  who: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${who}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
}

describe('GET /v1/connection-entries', () => {
  test('any member reads the apps this server knows: what each permission allows, not what it grants', async () => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'GET', '/v1/connection-entries');
    expect(res.status).toBe(200);
    const [first, second] = res.json.data;
    expect(first).toMatchObject({
      id: 'google',
      name: 'Google',
      owners: ['member', 'company'],
      signIn: { kind: 'oauth2' },
      setupGuide: google.setupGuide,
    });
    expect(first.permissions['gmail.send']).toEqual({ says: 'Send mail as you', changes: true });
    expect(second).toMatchObject({
      id: 'github',
      owners: ['company'],
      signIn: { kind: 'github-app' },
    });
    expect(JSON.stringify(res.json)).not.toContain('googleapis.com/auth');
  });

  test("each app says whether a registration names a directory, and what a disconnect withdraws there: Microsoft's has no default and withdraws nothing, Google's revoke is grant-wide and it reports removals", async () => {
    const oauth2 = microsoft.signIn as Extract<SignIn, { kind: 'oauth2' }>;
    const withDefault: AppEntry = {
      ...microsoft,
      id: 'acme-directory',
      signIn: { ...oauth2, tenant: { default: 'organizations' } },
    };
    const { app } = makeApp({ entries: [google, github, microsoft, withDefault] });
    const res = await call(app, 'ana', 'GET', '/v1/connection-entries');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      res.json.data.map((entry: Record<string, any>) => [entry.id, entry]),
    );
    expect(byId.microsoft.signIn).toEqual({ kind: 'oauth2', tenant: {} });
    expect(byId.microsoft.removal).toEqual({});
    expect(byId['acme-directory'].signIn).toEqual({
      kind: 'oauth2',
      tenant: { default: 'organizations' },
    });
    expect(byId.google.signIn).toEqual({ kind: 'oauth2' });
    expect(byId.google.removal).toEqual({
      revoke: 'oauth2-revoke',
      revokeIsGrantWide: true,
      notices: 'google-risc',
    });
    expect(byId.github.signIn).toEqual({ kind: 'github-app' });
    expect(byId.github.removal).toEqual({
      revoke: 'github-installation-token',
      notices: 'github-webhooks',
    });
  });

  test("a field an entry's tenant or removal carries that the schema doesn't list stays off the wire", async () => {
    const oauth2 = microsoft.signIn as Extract<SignIn, { kind: 'oauth2' }>;
    const ahead = {
      ...microsoft,
      id: 'acme-ahead',
      signIn: { ...oauth2, tenant: { default: 'organizations', region: 'eu' } },
      removal: { ...google.removal, reportsTo: 'acme-hook' },
    } as AppEntry;
    const { app } = makeApp({ entries: [ahead] });
    const res = await call(app, 'ana', 'GET', '/v1/connection-entries');
    expect(res.status).toBe(200);
    const [entry] = res.json.data;
    expect(entry.signIn).toEqual({ kind: 'oauth2', tenant: { default: 'organizations' } });
    expect(entry.removal).toEqual({
      revoke: 'oauth2-revoke',
      revokeIsGrantWide: true,
      notices: 'google-risc',
    });
  });
});

describe('/v1/connection-apps', () => {
  test("registers the tenant's own client, its secret by reference", async () => {
    const { app, calls } = makeApp();
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'google',
      label: 'Acme mail',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: SECRET },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      app: 'google',
      label: 'Acme mail',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: SECRET },
      redirectUrl: 'https://kindgi.acme.example/console/connect/callback',
    });
    expect(calls.createApp?.[0]).toMatchObject({ by: { kind: 'user', id: ADMIN } });
    const read = await call(app, 'admin', 'GET', `/v1/connection-apps/${res.json.appId}`);
    expect(read.json.appId).toBe(res.json.appId);
    const listed = await call(app, 'admin', 'GET', '/v1/connection-apps');
    expect(listed.json).toMatchObject({ data: [{ appId: res.json.appId }], hasMore: false });
  });

  test("passes a registration's directory to the binding, and shows it", async () => {
    const { app, calls } = makeApp();
    const oauth2 = { clientId: 'c-1', clientSecret: SECRET, tenant: 'acme.onmicrosoft.com' };
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'microsoft',
      oauth2,
    });
    expect(res.status).toBe(201);
    expect(res.json.oauth2).toEqual(oauth2);
    expect(calls.createApp?.[0]).toMatchObject({ oauth2: { tenant: 'acme.onmicrosoft.com' } });
  });

  test("without an authorizer, a key's tenant-admin scope decides: a member key neither registers nor re-points an app", async () => {
    const { app, calls } = makeApp();
    const body = {
      app: 'google',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: SECRET },
    };
    for (const who of ['ana', 'admin-member-key']) {
      const res = await call(app, who, 'POST', '/v1/connection-apps', body);
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('permission-denied');
    }
    expect(calls.createApp).toBeUndefined();
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', body);
    expect(created.status).toBe(201);
    const path = `/v1/connection-apps/${created.json.appId}`;
    const repoint = {
      oauth2: { clientId: 'elsewhere.apps.googleusercontent.com', clientSecret: SECRET },
    };
    for (const [method, sent] of [
      ['PATCH', repoint],
      ['GET', undefined],
      ['DELETE', undefined],
    ] as const) {
      const res = await call(app, 'admin-member-key', method, path, sent);
      expect(res.status).toBe(403);
    }
    expect((await call(app, 'ana', 'GET', '/v1/connection-apps')).status).toBe(403);
    expect(calls.updateApp).toBeUndefined();
    expect(calls.removeApp).toBeUndefined();
    expect((await call(app, 'admin', 'PATCH', path, repoint)).status).toBe(200);
  });

  test.each([
    ['no app', { label: 'x' }, 'app'],
    ['an app that is not an entry id', { app: 'Google' }, 'app'],
    ['a field it does not know', { app: 'google', scopes: ['x'] }, 'scopes'],
    [
      'a client secret that is not a reference',
      { app: 'google', oauth2: { clientId: 'c', clientSecret: 'plain' } },
      'oauth2.clientSecret',
    ],
    [
      'a field oauth2 does not know',
      { app: 'google', oauth2: { clientId: 'c', clientSecret: SECRET, region: 'eu' } },
      'oauth2.region',
    ],
    [
      "a tenant that isn't a string",
      { app: 'microsoft', oauth2: { clientId: 'c', clientSecret: SECRET, tenant: 7 } },
      'oauth2.tenant',
    ],
    [
      'an empty tenant',
      { app: 'microsoft', oauth2: { clientId: 'c', clientSecret: SECRET, tenant: '' } },
      'oauth2.tenant',
    ],
    ['a project twice', { app: 'google', projects: ['p-1', 'p-1'] }, 'projects'],
    ['every project spelled as null on a create', { app: 'google', projects: null }, 'projects'],
  ])('refuses a create with %s, naming the field', async (_what, body, field) => {
    const { app, calls } = makeApp();
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', body);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field } });
    expect(calls.createApp).toBeUndefined();
  });

  test('a reserved `kindgi.` name as its secret is refused, made or changed, before the binding', async () => {
    const { app, calls } = makeApp();
    const held = { envName: 'local', name: 'kindgi.google-client' };
    const made = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'google',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: held },
    });
    expect([made.status, made.json.error?.code]).toEqual([400, 'reserved-name-prefix']);
    expect(made.json.error.message).toContain('a connection app never names one');
    expect(calls.createApp).toBeUndefined();
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', { app: 'google' });
    const changed = await call(app, 'admin', 'PATCH', `/v1/connection-apps/${created.json.appId}`, {
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: held },
    });
    expect([changed.status, changed.json.error?.code]).toEqual([400, 'reserved-name-prefix']);
    expect(calls.updateApp).toBeUndefined();
  });

  test("answers the binding's refusal in the error body's code", async () => {
    const { app } = makeApp();
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', { app: 'acme' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('connection-app-unknown-entry');
  });

  test("an update can't change the app, and takes null for every project", async () => {
    const { app, calls } = makeApp();
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', { app: 'google' });
    const path = `/v1/connection-apps/${created.json.appId}`;
    const moved = await call(app, 'admin', 'PATCH', path, { app: 'github' });
    expect(moved.status).toBe(400);
    expect(moved.json.error.details).toEqual({ field: 'app' });
    const every = await call(app, 'admin', 'PATCH', path, { projects: null, label: 'All' });
    expect(every.status).toBe(200);
    expect(calls.updateApp?.[0]).toMatchObject({ projects: null, label: 'All' });
  });

  test('a removal takes withConnections, true or false only', async () => {
    const { app, calls } = makeApp();
    const path = `/v1/connection-apps/${randomUUID()}`;
    expect((await call(app, 'admin', 'DELETE', `${path}?withConnections=yes`)).status).toBe(400);
    const removed = await call(app, 'admin', 'DELETE', `${path}?withConnections=true`);
    expect(removed.json).toEqual({ connectionsRemoved: 2 });
    await call(app, 'admin', 'DELETE', path);
    expect(
      calls.removeApp?.map((i) => (i as { withConnections: boolean }).withConnections),
    ).toEqual([true, false]);
  });

  test('a list of registrations takes includeRemoved, true or false only', async () => {
    const { app, calls } = makeApp();
    await call(app, 'admin', 'GET', '/v1/connection-apps');
    await call(app, 'admin', 'GET', '/v1/connection-apps?includeRemoved=true');
    await call(app, 'admin', 'GET', '/v1/connection-apps?includeRemoved=false');
    expect(calls.listApps?.map((i) => (i as { includeRemoved?: boolean }).includeRemoved)).toEqual([
      undefined,
      true,
      undefined,
    ]);
    const res = await call(app, 'admin', 'GET', '/v1/connection-apps?includeRemoved=yes');
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ field: 'includeRemoved' });
    expect(calls.listApps).toHaveLength(3);
  });

  test('an id that is not one is a 400, before the binding', async () => {
    const { app } = makeApp();
    const res = await call(app, 'admin', 'GET', '/v1/connection-apps/not-an-id');
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad-input');
  });
});

describe('POST /v1/connections (a connect from outside a run)', () => {
  test('a member connects their own account, under the env the server serves', async () => {
    const { app, calls } = makeApp();
    const res = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      app: 'google',
      owner: { kind: 'member', userId: ANA },
      envName: 'local',
      permissions: ['gmail.send'],
      says: ['Send mail as you'],
      state: 'pending',
    });
    expect(calls.createRequest?.[0]).toMatchObject({
      envName: 'local',
      owner: { kind: 'member', userId: ANA },
      by: { kind: 'user', id: ANA, tenantId: tenantA },
    });
  });

  test("only a tenant admin connects the company's account", async () => {
    const { app } = makeApp();
    const body = { app: 'google', permissions: ['gmail.send'], for: 'company' };
    const member = await call(app, 'ana', 'POST', '/v1/connections', body);
    expect(member.status).toBe(403);
    const admin = await call(app, 'admin', 'POST', '/v1/connections', body);
    expect(admin.status).toBe(201);
    expect(admin.json.owner).toEqual({ kind: 'company' });
  });

  test('a service account has no account of its own to connect', async () => {
    const { app } = makeApp();
    const res = await call(app, 'bot', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ field: 'for' });
  });

  test.each([
    ['no permissions', { app: 'google', permissions: [] }, 'permissions'],
    [
      'a permission twice',
      { app: 'google', permissions: ['gmail.send', 'gmail.send'] },
      'permissions',
    ],
    [
      'an appId that is not one',
      { app: 'google', appId: 'x', permissions: ['gmail.send'] },
      'appId',
    ],
    [
      'an owner other than me or company',
      { app: 'google', permissions: ['gmail.send'], for: 'team' },
      'for',
    ],
  ])('refuses %s, naming the field', async (_what, body, field) => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'POST', '/v1/connections', body);
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ field });
  });

  test("the binding's bad-input names its field too", async () => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['drive.everything'],
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field: 'permissions' } });
  });
});

describe('a connect request: read, start and finish', () => {
  async function requested(app: App, who: string, forWhom: 'me' | 'company' = 'me') {
    const res = await call(app, who, 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      for: forWhom,
    });
    return res.json.requestId as string;
  }

  test("a member's request is theirs alone: anyone else, an admin too, gets the same 404", async () => {
    const { app } = makeApp();
    const requestId = await requested(app, 'ana');
    const path = `/v1/connections/requests/${requestId}`;
    expect((await call(app, 'ana', 'GET', path)).status).toBe(200);
    for (const who of ['ben', 'admin', 'other']) {
      const res = await call(app, who, 'GET', path);
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('connection-request-not-found');
    }
    expect((await call(app, 'ben', 'POST', `${path}/start`)).status).toBe(404);
  });

  test("the company's request is a tenant admin's", async () => {
    const { app } = makeApp();
    const requestId = await requested(app, 'admin', 'company');
    const path = `/v1/connections/requests/${requestId}`;
    expect((await call(app, 'admin', 'GET', path)).status).toBe(200);
    expect((await call(app, 'ana', 'GET', path)).status).toBe(404);
  });

  test("the owner starts it, and gets the app's consent page", async () => {
    const { app, calls } = makeApp();
    const requestId = await requested(app, 'ana');
    const res = await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s-1',
    });
    expect(calls.startRequest?.[0]).toMatchObject({ caller: { kind: 'user', id: ANA } });
  });

  test("a GitHub App's start takes the installation picked, or a new one; the request lists the ones to pick", async () => {
    const { app, calls, requests } = makeApp();
    const requestId = await requested(app, 'ana');
    const installations = [
      { installationId: '101', account: { id: '1', label: 'acme' } },
      { installationId: '102', account: { id: '2', label: 'acme-labs' } },
    ];
    requests.set(requestId, {
      ...(requests.get(requestId) as ConnectRequestRecord),
      installations,
    });
    const read = await call(app, 'ana', 'GET', `/v1/connections/requests/${requestId}`);
    expect(read.json).toMatchObject({ state: 'pending', installations });
    expect(read.json.failure).toBeUndefined();

    const path = `/v1/connections/requests/${requestId}/start`;
    for (const body of [
      { installationId: '102' },
      { newInstallation: true },
      { newInstallation: false },
      {},
    ]) {
      expect((await call(app, 'ana', 'POST', path, body)).status).toBe(200);
    }
    const [picked, fresh, notFresh, none] = calls.startRequest ?? [];
    expect(picked).toMatchObject({ installationId: '102' });
    expect(picked).not.toHaveProperty('newInstallation');
    expect(fresh).toMatchObject({ newInstallation: true });
    expect(fresh).not.toHaveProperty('installationId');
    for (const neither of [notFresh, none]) {
      expect(neither).not.toHaveProperty('installationId');
      expect(neither).not.toHaveProperty('newInstallation');
    }
  });

  test("a start's body is checked for shape before the binding sees it", async () => {
    const { app, calls } = makeApp();
    const requestId = await requested(app, 'ana');
    const path = `/v1/connections/requests/${requestId}/start`;
    for (const [body, field] of [
      [{ installationId: '' }, 'installationId'],
      [{ installationId: 'x'.repeat(65) }, 'installationId'],
      [{ installationId: 101 }, 'installationId'],
      [{ newInstallation: 'yes' }, 'newInstallation'],
      [{ installationId: '101', newInstallation: true }, 'newInstallation'],
      [{ installation: '101' }, 'installation'],
    ] as const) {
      const res = await call(app, 'ana', 'POST', path, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field } });
    }
    const notAnObject = await call(app, 'ana', 'POST', path, ['101']);
    expect(notAnObject.status).toBe(400);
    expect(calls.startRequest).toBeUndefined();
  });

  test('whoever started it finishes it: the request and the new connection', async () => {
    const { app, calls } = makeApp();
    const requestId = await requested(app, 'ana');
    await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    const res = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'code-1',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      kind: 'connected',
      request: { requestId, state: 'connected' },
      connection: { app: 'google', owner: { kind: 'member', userId: ANA }, state: 'working' },
    });
    // No approvals on this server: nothing said about a reviewer seat.
    expect(res.json.reviewerSeat).toBeUndefined();
    expect(calls.finishRequest?.[0]).toMatchObject({ state: 's-1', code: 'code-1' });
    const other = await call(app, 'ben', 'POST', '/v1/connections/finish', { state: 's-1' });
    expect(other.status).toBe(403);
    expect(other.json.error.code).toBe('connection-not-yours');
  });

  test('a finish by someone else is refused, and the access audit records it', async () => {
    const recorded: { action: Action; resource: string; decision: Decision }[] = [];
    const grant = (action: Action, r: ResourceRef): Decision => ({
      allowed: true,
      reason: 'test: granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    });
    const { app } = makeApp({
      authzCheckBinding: {
        check: async (_p, action, r) => grant(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => grant(action, r)),
        recordDecision: (_p, action, r, decision) => {
          recorded.push({ action, resource: `${r.type}:${r.id}`, decision });
        },
      },
    });
    const requestId = await requested(app, 'ana');
    await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    expect(recorded).toEqual([]);
    const other = await call(app, 'ben', 'POST', '/v1/connections/finish', { state: 's-1' });
    expect(other.status).toBe(403);
    expect(other.json.error.code).toBe('connection-not-yours');
    expect(recorded).toEqual([
      {
        action: 'write',
        resource: `tenant:${tenantA}`,
        decision: expect.objectContaining({ allowed: false, failing: 'actor' }),
      },
    ]);
  });

  test("a GitHub App's finish: several installations to pick from, or none the person reaches", async () => {
    const recorded: string[] = [];
    const { app } = makeApp({
      authzCheckBinding: {
        check: async () => ({ allowed: true, reason: 'test', evidence: {} as never }),
        checkBatch: async (_p, _a, rs) =>
          rs.map(() => ({ allowed: true, reason: 'test', evidence: {} as never })),
        recordDecision: (_p, action, r) => {
          recorded.push(`${action} ${r.type}:${r.id}`);
        },
      },
    });
    const requestId = await requested(app, 'ana');
    await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    const pick = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'several',
    });
    expect(pick.status).toBe(200);
    expect(pick.json).toMatchObject({
      kind: 'pick-installation',
      request: { requestId, state: 'pending', installations: [{ installationId: '101' }, {}] },
    });
    expect(pick.json.connection).toBeUndefined();
    expect(pick.json.request.failure).toBeUndefined();

    const none = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'unreachable',
    });
    expect(none.status).toBe(403);
    expect(none.json.error).toMatchObject({
      code: 'connection-installation-unreachable',
      details: { connectRequestId: requestId },
    });
    expect(recorded).toEqual([`write tenant:${tenantA}`]);
  });

  test('a finish needs the state the app sent back, and takes only what the app sends', async () => {
    const { app } = makeApp();
    const noState = await call(app, 'ana', 'POST', '/v1/connections/finish', { code: 'c' });
    expect(noState.json.error.details).toEqual({ field: 'state' });
    const extra = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's',
      scope: 'x',
    });
    expect(extra.json.error.details).toEqual({ field: 'scope' });
  });

  test('on a server with approvals, the finish says whether the member has a reviewer seat', async () => {
    const reviewers: ReviewerBinding = {
      resolveReviewer: async ({ userId }) => (userId === ANA ? ('rev-ana' as never) : null),
    };
    for (const [who, seat] of [
      ['ana', true],
      ['ben', false],
    ] as const) {
      const { app } = makeApp({ reviewers });
      const requestId = await requested(app, who);
      await call(app, who, 'POST', `/v1/connections/requests/${requestId}/start`);
      const res = await call(app, who, 'POST', '/v1/connections/finish', {
        state: 's-1',
        code: 'c',
      });
      expect(res.json.reviewerSeat).toBe(seat);
    }
  });
});

describe('the connections themselves', () => {
  test('a member lists their own; a tenant admin every one, or their own with owner=me', async () => {
    const { app, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const bens = connected({ kind: 'member', userId: BEN });
    const company = connected({ kind: 'company' });
    connected({ kind: 'member', userId: ANA }, tenantB);
    const ids = (res: { json: Record<string, any> }) =>
      (res.json.data as { connectionId: string }[]).map((c) => c.connectionId).sort();

    expect(ids(await call(app, 'ana', 'GET', '/v1/connections'))).toEqual([anas.connectionId]);
    expect(ids(await call(app, 'ana', 'GET', '/v1/connections?ownerKind=company'))).toEqual([]);
    expect(ids(await call(app, 'admin', 'GET', '/v1/connections'))).toEqual(
      [anas.connectionId, bens.connectionId, company.connectionId].sort(),
    );
    expect(ids(await call(app, 'admin', 'GET', '/v1/connections?ownerKind=company'))).toEqual([
      company.connectionId,
    ]);
    expect(ids(await call(app, 'admin', 'GET', '/v1/connections?owner=me'))).toEqual([]);
    expect(ids(await call(app, 'bot', 'GET', '/v1/connections'))).toEqual([]);
  });

  test.each([
    ['owner', 'someone'],
    ['ownerKind', 'team'],
    ['state', 'broken'],
    ['app', 'Google'],
    ['includeRemoved', 'yes'],
  ])('a list refuses %s=%s', async (name, value) => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'GET', `/v1/connections?${name}=${value}`);
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ field: name });
  });

  test('state=removed lists removed ones', async () => {
    const { app, calls } = makeApp();
    await call(app, 'admin', 'GET', '/v1/connections?state=removed');
    expect(calls.list?.[0]).toMatchObject({ state: 'removed', includeRemoved: true });
  });

  test('includeRemoved=true lists removed ones with the others, and a state still narrows it', async () => {
    const { app, calls } = makeApp();
    await call(app, 'admin', 'GET', '/v1/connections?includeRemoved=true');
    await call(app, 'admin', 'GET', '/v1/connections?state=working&includeRemoved=true');
    await call(app, 'admin', 'GET', '/v1/connections?includeRemoved=false');
    await call(app, 'admin', 'GET', '/v1/connections?state=working');
    expect(calls.list?.[0]).toMatchObject({ includeRemoved: true });
    expect(calls.list?.[0]).not.toHaveProperty('state');
    expect(calls.list?.[1]).toMatchObject({ state: 'working', includeRemoved: true });
    expect(calls.list?.[2]).not.toHaveProperty('includeRemoved');
    expect(calls.list?.[3]).toMatchObject({ state: 'working' });
    expect(calls.list?.[3]).not.toHaveProperty('includeRemoved');
  });

  test("a connection is its owner's and a tenant admin's; anyone else gets the same 404", async () => {
    const { app, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const path = `/v1/connections/${anas.connectionId}`;
    expect((await call(app, 'ana', 'GET', path)).json).toMatchObject({
      connectionId: anas.connectionId,
      account: { id: '1234', label: 'user-ana@acme.example' },
    });
    expect((await call(app, 'admin', 'GET', path)).status).toBe(200);
    for (const who of ['ben', 'bot', 'other']) {
      const res = await call(app, who, 'GET', path);
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('connection-not-found');
    }
    expect((await call(app, 'ben', 'DELETE', path)).status).toBe(404);
  });

  test('one the app gave no refresh token says when its access ends, and why it needs reconnecting', async () => {
    const { app, connected } = makeApp();
    const ends = { accessEndsAt: '2026-12-21T12:00:00.000Z' };
    const anas = connected({ kind: 'member', userId: ANA }, tenantA, {
      state: 'needs-reconnecting',
      stateReason: 'access-expired',
      ...ends,
    });
    const res = await call(app, 'ana', 'GET', `/v1/connections/${anas.connectionId}`);
    expect(res.json).toMatchObject({
      state: 'needs-reconnecting',
      stateReason: 'access-expired',
      ...ends,
    });
    const renews = connected({ kind: 'member', userId: BEN });
    const listed = await call(app, 'admin', 'GET', '/v1/connections');
    const of = (id: string) =>
      (listed.json.data as { connectionId: string; accessEndsAt?: string }[]).find(
        (c) => c.connectionId === id,
      );
    expect(of(anas.connectionId)).toMatchObject(ends);
    expect(of(renews.connectionId)).not.toHaveProperty('accessEndsAt');
  });

  test('its owner disconnects it: the removed record, never a token', async () => {
    const { app, calls, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const res = await call(app, 'ana', 'DELETE', `/v1/connections/${anas.connectionId}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      state: 'removed',
      removedReason: 'disconnected',
      withdrawn: 'at-app',
    });
    expect(calls.disconnect?.[0]).toMatchObject({ by: { kind: 'user', id: ANA } });
    expect(JSON.stringify(res.json)).not.toMatch(/token/i);
  });
});

describe('POST /v1/connection-notices/{tenantId}/{appId}', () => {
  const path = `/v1/connection-notices/${tenantA}/${randomUUID()}`;
  const send = (app: App, signature: string, client = '203.0.113.9', to = path) =>
    app.request(to, {
      method: 'POST',
      headers: {
        'X-Acme-Signature': signature,
        'content-type': 'application/secevent+jwt',
        'x-forwarded-for': client,
      },
      body: 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln',
    });

  test('needs no bearer: the binding checks the exact bytes and the headers, named in lower case', async () => {
    const { app, calls } = makeApp();
    const res = await send(app, 'good');
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    const received = calls.receiveNotice?.[0] as {
      tenantId: string;
      headers: Record<string, string>;
      rawBody: Uint8Array;
    };
    expect(received.tenantId).toBe(tenantA);
    expect(received.headers['x-acme-signature']).toBe('good');
    expect(new TextDecoder().decode(received.rawBody)).toBe('eyJhbGciOiJSUzI1NiJ9.e30.c2ln');
  });

  test('every refusal gets the same 400, whatever was wrong', async () => {
    const { app, calls } = makeApp();
    const bodies = await Promise.all(
      [
        send(app, 'forged'),
        send(app, 'good', '203.0.113.9', `/v1/connection-notices/not-a-tenant/${randomUUID()}`),
      ].map(async (pending) => {
        const res = await pending;
        expect(res.status).toBe(400);
        const { error } = (await res.json()) as { error: Record<string, unknown> };
        return { code: error.code, message: error.message, details: error.details };
      }),
    );
    expect(bodies[0]).toEqual({
      code: 'connection-notice-invalid',
      message: 'The notice was not accepted',
      details: undefined,
    });
    expect(bodies[1]).toEqual(bodies[0]);
    // The malformed id never reached the binding.
    expect(calls.receiveNotice).toHaveLength(1);
  });

  test("the server's own trouble is a 503, and the app sends it again", async () => {
    const { app } = makeApp();
    const res = await send(app, 'store-down');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'connection-notice-unavailable',
    );
  });

  test('a client past its refusals this minute gets a 429; another client does not', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 60; i += 1) expect((await send(app, 'forged')).status).toBe(400);
    const limited = await send(app, 'forged');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect((await send(app, 'forged', '198.51.100.7')).status).toBe(400);
  });
});

describe('mounting', () => {
  test('connections need the env the server serves', () => {
    const memory = memoryBinding();
    expect(() =>
      createApp({
        ...createStubAppBindings(),
        resolveToken,
        runHandler,
        connections: memory.binding,
      }),
    ).toThrow(/`connections` needs `envName`/);
  });
});
