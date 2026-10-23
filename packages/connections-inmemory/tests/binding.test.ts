// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ConnectRequestRecord } from '@kindgi/api';
import type { PrincipalRef } from '@kindgi/authz';
import { github } from '@kindgi/connections/github';
import { google } from '@kindgi/connections/google';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import { type FakeApp, createInMemoryConnections } from '../src/index.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const envName = 'local' as EnvName;
const ana: PrincipalRef = { kind: 'user', id: 'user-ana', tenantId };
const ben: PrincipalRef = { kind: 'user', id: 'user-ben', tenantId };
const admin: PrincipalRef = { kind: 'user', id: 'user-admin', tenantId };
const SECRET = { envName, name: 'ACME_CLIENT_SECRET' };
const START = Date.parse('2026-10-22T12:00:00.000Z');

function setup(app: FakeApp = {}, onConnectComplete = vi.fn(async () => {})) {
  let at = START;
  const clock = {
    advance: (ms: number) => {
      at += ms;
    },
  };
  const made = createInMemoryConnections({
    entries: [google, github],
    publicUrl: 'https://kindgi.acme.example/',
    now: () => at,
    app,
    onConnectComplete,
  });
  const googleApp = made.seed.app({
    tenantId,
    app: 'google',
    oauth2: { clientId: 'acme.apps.googleusercontent.com', clientSecret: SECRET },
    by: admin,
  });
  const githubApp = made.seed.app({
    tenantId,
    app: 'github',
    githubApp: {
      appNumber: 7,
      slug: 'acme-kindgi',
      clientId: 'Iv1.acme',
      clientSecret: SECRET,
      privateKey: SECRET,
      webhookSecret: SECRET,
    },
    by: admin,
  });
  return { ...made, clock, googleApp, githubApp, onConnectComplete };
}

type Made = ReturnType<typeof setup>;

async function request(
  made: Made,
  input: { app?: string; owner?: 'ana' | 'company'; permissions?: string[] } = {},
): Promise<ConnectRequestRecord> {
  const created = await made.binding.createRequest({
    tenantId,
    envName,
    app: input.app ?? 'google',
    owner: input.owner === 'company' ? { kind: 'company' } : { kind: 'member', userId: ana.id },
    permissions: input.permissions ?? ['gmail.send'],
    by: input.owner === 'company' ? admin : ana,
  });
  if (created.kind !== 'ok') throw new Error(created.error.message);
  return created.value;
}

async function start(
  made: Made,
  requestId: string,
  caller: PrincipalRef = ana,
  more: { installationId?: string; newInstallation?: true } = {},
): Promise<URL> {
  const started = await made.binding.startRequest({ tenantId, requestId, caller, ...more });
  if (started.kind !== 'ok') throw new Error(started.error.message);
  return new URL(started.value.authorizeUrl);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createInMemoryConnections', () => {
  test('refuses NODE_ENV=production unless productionSafe', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const options = { entries: [google], publicUrl: 'https://kindgi.acme.example' };
    expect(() => createInMemoryConnections(options)).toThrow(/NODE_ENV=production/);
    expect(() => createInMemoryConnections({ ...options, productionSafe: true })).not.toThrow();
  });
});

describe('app registrations', () => {
  test('a registration fits its entry, and its addresses are the server’s', async () => {
    const made = setup();
    expect(made.googleApp).toMatchObject({
      redirectUrl: 'https://kindgi.acme.example/console/connect/callback',
      noticesUrl: `https://kindgi.acme.example/v1/connection-notices/${tenantId}/${made.googleApp.appId}`,
    });
    const unknown = await made.binding.createApp({ tenantId, app: 'acme', by: admin });
    expect(unknown).toMatchObject({ kind: 'err', error: { code: 'connection-app-unknown-entry' } });
    const wrongKind = await made.binding.createApp({
      tenantId,
      app: 'google',
      githubApp: made.githubApp.githubApp,
      by: admin,
    });
    expect(wrongKind).toMatchObject({
      kind: 'err',
      error: { code: 'connection-app-invalid', field: 'githubApp' },
    });
    const moved = await made.binding.updateApp({
      tenantId,
      appId: made.googleApp.appId,
      projects: ['p-1' as ProjectId],
      by: admin,
    });
    expect(moved).toMatchObject({ kind: 'ok', value: { projects: ['p-1'] } });
    const every = await made.binding.updateApp({
      tenantId,
      appId: made.googleApp.appId,
      projects: null,
      by: admin,
    });
    expect(every.kind === 'ok' && every.value.projects).toBe(undefined);
  });

  test('a registration in use is removed only with its connections', async () => {
    const made = setup();
    const connection = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: ana.id },
      account: { id: 'g-ana', label: 'ana@acme.example' },
      permissions: ['gmail.send'],
    });
    const input = { tenantId, appId: made.googleApp.appId, by: admin };
    expect(await made.binding.removeApp({ ...input, withConnections: false })).toMatchObject({
      kind: 'err',
      error: { code: 'connection-app-in-use' },
    });
    expect(await made.binding.removeApp({ ...input, withConnections: true })).toEqual({
      kind: 'ok',
      value: { connectionsRemoved: 1 },
    });
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({
      state: 'removed',
      removedReason: 'registration-removed',
      withdrawn: 'at-app',
    });
    expect(await made.binding.getApp({ tenantId, appId: made.googleApp.appId })).toHaveProperty(
      'removedAt',
    );
  });

  test('a project uses one registration of an app', async () => {
    const made = setup();
    const p1 = 'p-1' as ProjectId;
    const p2 = 'p-2' as ProjectId;
    const create = (projects?: ProjectId[]) =>
      made.binding.createApp({
        tenantId,
        app: 'google',
        oauth2: { clientId: 'other.apps.googleusercontent.com', clientSecret: SECRET },
        ...(projects !== undefined && { projects }),
        by: admin,
      });
    const move = (appId: string, projects: ProjectId[] | null) =>
      made.binding.updateApp({ tenantId, appId, projects, by: admin });
    const overlaps = { kind: 'err', error: { code: 'connection-app-invalid', field: 'projects' } };
    // The seeded one serves every project, so another overlaps it wherever it serves.
    expect(await create()).toMatchObject(overlaps);
    // Another company's registration of the app doesn't count.
    const otherTenantId = '00000000-0000-4000-8000-0000000000bb' as TenantId;
    const theirs = await made.binding.createApp({
      tenantId: otherTenantId,
      app: 'google',
      oauth2: { clientId: 'other.apps.googleusercontent.com', clientSecret: SECRET },
      by: { ...admin, tenantId: otherTenantId },
    });
    expect(theirs).toMatchObject({ kind: 'ok' });
    expect(await create([p2])).toMatchObject(overlaps);
    expect(await move(made.googleApp.appId, [p1])).toMatchObject({ kind: 'ok' });
    expect(await create([p1, p2])).toMatchObject(overlaps);
    const second = await create([p2]);
    if (second.kind !== 'ok') throw new Error(second.error.message);
    // Neither moves onto the other's project, nor to every project.
    expect(await move(made.googleApp.appId, [p2])).toMatchObject(overlaps);
    expect(await move(made.googleApp.appId, null)).toMatchObject(overlaps);
    expect(await move(second.value.appId, [p1, p2])).toMatchObject(overlaps);
    // Another app's registration, and a removed one, don't count.
    expect(await move(made.githubApp.appId, [p1])).toMatchObject({ kind: 'ok' });
    const removed = await made.binding.removeApp({
      tenantId,
      appId: second.value.appId,
      withConnections: false,
      by: admin,
    });
    expect(removed).toMatchObject({ kind: 'ok' });
    expect(await move(made.googleApp.appId, null)).toMatchObject({ kind: 'ok' });
  });

  test("a registration's client changes only while no connection was granted to it", async () => {
    const made = setup();
    const google1 = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: ana.id },
      account: { id: 'g-ana', label: 'ana@acme.example' },
      permissions: ['gmail.send'],
    });
    made.seed.connection({
      tenantId,
      envName,
      app: 'github',
      owner: { kind: 'company' },
      account: { id: '1', label: 'acme' },
      permissions: ['issues.read'],
      installationId: '101',
    });
    const googleClient = (clientId: string, name = 'ACME_CLIENT_SECRET') => ({
      oauth2: { clientId, clientSecret: { envName, name } },
    });
    const updateGoogle = (change: ReturnType<typeof googleClient>) =>
      made.binding.updateApp({ tenantId, appId: made.googleApp.appId, ...change, by: admin });
    const githubApp = made.githubApp.githubApp;
    if (githubApp === undefined) throw new Error('the GitHub registration has no githubApp');
    const updateGitHub = (change: Partial<typeof githubApp>) =>
      made.binding.updateApp({
        tenantId,
        appId: made.githubApp.appId,
        githubApp: { ...githubApp, ...change },
        by: admin,
      });
    const changed = (field: string) => ({
      kind: 'err',
      error: { code: 'connection-app-invalid', field },
    });
    expect(await updateGoogle(googleClient('other.apps.googleusercontent.com'))).toMatchObject(
      changed('oauth2.clientId'),
    );
    expect(await updateGitHub({ appNumber: 8 })).toMatchObject(changed('githubApp.appNumber'));
    expect(await updateGitHub({ clientId: 'Iv1.other' })).toMatchObject(
      changed('githubApp.clientId'),
    );
    // The same client with another secret, slug or key isn't another client.
    expect(
      await updateGoogle(googleClient('acme.apps.googleusercontent.com', 'ACME_CLIENT_SECRET_2')),
    ).toMatchObject({ kind: 'ok' });
    expect(await updateGitHub({ slug: 'acme-kindgi-2' })).toMatchObject({ kind: 'ok' });
    // Once its connection is disconnected, Google's client changes.
    await made.binding.disconnect({ tenantId, connectionId: google1.connectionId, by: ana });
    expect(await updateGoogle(googleClient('other.apps.googleusercontent.com'))).toMatchObject({
      kind: 'ok',
      value: { oauth2: { clientId: 'other.apps.googleusercontent.com' } },
    });
  });
});

describe('a connect, without a browser', () => {
  test('start gives the consent page with a fresh state; the finish with code "ok" connects', async () => {
    const made = setup();
    const created = await request(made);
    expect(created).toMatchObject({
      state: 'pending',
      says: ['Send mail as you'],
      connectUrl: `https://kindgi.acme.example/console/connect/${created.requestId}`,
      expiresAt: '2026-10-22T13:00:00.000Z',
    });
    const url = await start(made, created.requestId);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/gmail.send',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    const state = url.searchParams.get('state') as string;

    const finished = await made.binding.finishRequest({ tenantId, caller: ana, state, code: 'ok' });
    expect(finished).toMatchObject({
      kind: 'ok',
      value: {
        kind: 'connected',
        request: { state: 'connected', startedBy: 'user:user-ana' },
        connection: {
          owner: { kind: 'member', userId: ana.id },
          account: { id: ana.id },
          permissions: ['gmail.send'],
          state: 'working',
        },
      },
    });
    expect(made.calls).toEqual([{ op: 'exchange', requestId: created.requestId, outcome: 'ok' }]);
    // No run waits on it: nothing to resume.
    expect(made.onConnectComplete).not.toHaveBeenCalled();
    // The state is used once.
    const again = await made.binding.finishRequest({ tenantId, caller: ana, state, code: 'ok' });
    expect(again).toMatchObject({ kind: 'err', error: { code: 'connection-request-not-found' } });
  });

  test('only whoever started it finishes it, while the request and the state live', async () => {
    const made = setup();
    const first = await request(made);
    const state = (await start(made, first.requestId)).searchParams.get('state') as string;
    expect(
      await made.binding.finishRequest({ tenantId, caller: ben, state, code: 'ok' }),
    ).toMatchObject({ kind: 'err', error: { code: 'connection-not-yours' } });
    made.clock.advance(10 * 60_000);
    expect(
      await made.binding.finishRequest({ tenantId, caller: ana, state, code: 'ok' }),
    ).toMatchObject({ kind: 'err', error: { code: 'connection-state-expired' } });
    // A fresh start works within the request's hour; past it, the request is gone.
    const fresh = (await start(made, first.requestId)).searchParams.get('state') as string;
    made.clock.advance(51 * 60_000);
    expect(
      await made.binding.finishRequest({ tenantId, caller: ana, state: fresh, code: 'ok' }),
    ).toMatchObject({ kind: 'err', error: { code: 'connection-request-expired' } });
    expect(await made.binding.getRequest({ tenantId, requestId: first.requestId })).toMatchObject({
      state: 'expired',
    });
    expect(
      await made.binding.startRequest({ tenantId, requestId: first.requestId, caller: ana }),
    ).toMatchObject({ kind: 'err', error: { code: 'connection-request-expired' } });
  });

  test('a decline, a refused code, and less granted than asked', async () => {
    const made = setup({
      exchange: ({ code }) =>
        code === 'partial'
          ? { account: { id: ana.id, label: 'ana' }, granted: ['gmail.send'] }
          : code === 'ok'
            ? { account: { id: ana.id, label: 'ana' } }
            : 'refused',
    });
    const declined = await request(made);
    const s1 = (await start(made, declined.requestId)).searchParams.get('state') as string;
    expect(
      await made.binding.finishRequest({
        tenantId,
        caller: ana,
        state: s1,
        error: 'access_denied',
      }),
    ).toMatchObject({ kind: 'ok', value: { kind: 'declined', request: { state: 'declined' } } });

    const refused = await request(made);
    const s2 = (await start(made, refused.requestId)).searchParams.get('state') as string;
    expect(
      await made.binding.finishRequest({ tenantId, caller: ana, state: s2, code: 'nope' }),
    ).toMatchObject({ kind: 'err', error: { code: 'connection-app-refused' } });
    expect(await made.binding.getRequest({ tenantId, requestId: refused.requestId })).toMatchObject(
      { state: 'failed', failure: 'app-refused' },
    );

    const partial = await request(made, { permissions: ['gmail.send', 'gmail.readonly'] });
    const s3 = (await start(made, partial.requestId)).searchParams.get('state') as string;
    const finished = await made.binding.finishRequest({
      tenantId,
      caller: ana,
      state: s3,
      code: 'partial',
    });
    expect(finished).toMatchObject({
      kind: 'ok',
      value: { kind: 'declined', request: { state: 'declined', missing: ['gmail.readonly'] } },
    });
    // What was granted is kept.
    const [kept] = (await made.binding.list({ tenantId, limit: 10 })).data;
    expect(kept).toMatchObject({ permissions: ['gmail.send'], state: 'working' });
  });

  test('a reconnect needs the same account, and asks for what the connection has too', async () => {
    const made = setup({
      exchange: ({ code }) => ({ account: { id: code, label: code } }),
    });
    const existing = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: ana.id },
      account: { id: 'g-ana', label: 'ana@acme.example' },
      permissions: ['gmail.readonly'],
    });
    const again = await request(made, { permissions: ['gmail.send'] });
    expect(again).toMatchObject({
      reconnects: existing.connectionId,
      permissions: ['gmail.send', 'gmail.readonly'],
    });
    const s1 = (await start(made, again.requestId)).searchParams.get('state') as string;
    expect(
      await made.binding.finishRequest({ tenantId, caller: ana, state: s1, code: 'g-someone' }),
    ).toMatchObject({ kind: 'err', error: { code: 'connection-account-mismatch' } });

    const third = await request(made, { permissions: ['gmail.send'] });
    const s2 = (await start(made, third.requestId)).searchParams.get('state') as string;
    const finished = await made.binding.finishRequest({
      tenantId,
      caller: ana,
      state: s2,
      code: 'g-ana',
    });
    expect(finished).toMatchObject({
      kind: 'ok',
      value: {
        kind: 'connected',
        connection: {
          connectionId: existing.connectionId,
          permissions: ['gmail.readonly', 'gmail.send'],
        },
      },
    });
  });

  test('a reconnect granted less than the connection had is declined, and leaves it as it was', async () => {
    const made = setup({
      exchange: () => ({ account: { id: 'g-ana', label: 'ana' }, granted: ['gmail.send'] }),
    });
    const existing = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: ana.id },
      account: { id: 'g-ana', label: 'ana@acme.example' },
      permissions: ['gmail.readonly'],
      state: 'needs-reconnecting',
    });
    const again = await request(made, { permissions: ['gmail.send'] });
    const state = (await start(made, again.requestId)).searchParams.get('state') as string;
    expect(
      await made.binding.finishRequest({ tenantId, caller: ana, state, code: 'ok' }),
    ).toMatchObject({
      kind: 'ok',
      value: { kind: 'declined', request: { state: 'declined', missing: ['gmail.readonly'] } },
    });
    expect(await made.binding.get({ tenantId, connectionId: existing.connectionId })).toMatchObject(
      { permissions: ['gmail.readonly'], state: 'needs-reconnecting' },
    );
  });

  test('a reconnect that keeps all the connection had is stored, and declines for the rest', async () => {
    const made = setup({
      exchange: () => ({ account: { id: 'g-ana', label: 'ana' }, granted: ['gmail.readonly'] }),
      notice: () => ({
        handled: 'sessions-revoked',
        accountId: 'g-ana',
        action: 'needs-reconnecting',
      }),
    });
    const existing = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: ana.id },
      account: { id: 'g-ana', label: 'ana@acme.example' },
      permissions: ['gmail.readonly'],
    });
    await made.binding.receiveNotice({
      tenantId,
      appId: made.googleApp.appId,
      headers: {},
      rawBody: new TextEncoder().encode('{}'),
    });
    expect(await made.binding.get({ tenantId, connectionId: existing.connectionId })).toMatchObject(
      { state: 'needs-reconnecting', stateReason: 'sessions-revoked' },
    );
    const again = await request(made, { permissions: ['gmail.send'] });
    const state = (await start(made, again.requestId)).searchParams.get('state') as string;
    expect(
      await made.binding.finishRequest({ tenantId, caller: ana, state, code: 'ok' }),
    ).toMatchObject({
      kind: 'ok',
      value: {
        kind: 'declined',
        request: {
          state: 'declined',
          missing: ['gmail.send'],
          connectionId: existing.connectionId,
        },
      },
    });
    const revived = await made.binding.get({ tenantId, connectionId: existing.connectionId });
    expect(revived).toMatchObject({
      permissions: ['gmail.readonly'],
      state: 'working',
      account: { label: 'ana' },
    });
    expect(revived).not.toHaveProperty('stateReason');
  });
});

describe('a request made before its connection gained a permission', () => {
  /** Ana's connection, widened to both permissions after two requests that ask for sending only. */
  async function widened() {
    const made = setup({
      exchange: ({ code }) => ({
        account:
          code === 'other'
            ? { id: 'g-other', label: 'other@acme.example' }
            : { id: 'g-ana', label: 'ana@acme.example' },
        granted: code === 'both' ? ['gmail.send', 'gmail.readonly'] : ['gmail.send'],
      }),
      notice: () => ({
        handled: 'sessions-revoked',
        accountId: 'g-ana',
        action: 'needs-reconnecting',
      }),
    });
    const earlier = [
      await request(made, { permissions: ['gmail.send'] }),
      await request(made, { permissions: ['gmail.send'] }),
    ];
    const wider = await request(made, { permissions: ['gmail.send', 'gmail.readonly'] });
    const state = (await start(made, wider.requestId)).searchParams.get('state') as string;
    const finished = await made.binding.finishRequest({
      tenantId,
      caller: ana,
      state,
      code: 'both',
    });
    if (finished.kind !== 'ok' || finished.value.kind !== 'connected') {
      throw new Error('expected a connect');
    }
    const finish = async (code: string, which = 0) =>
      made.binding.finishRequest({
        tenantId,
        caller: ana,
        state: (await start(made, earlier[which]?.requestId as string)).searchParams.get(
          'state',
        ) as string,
        code,
      });
    return { made, connectionId: finished.value.connection.connectionId, finish };
  }

  test('its grant, lacking the new permission, leaves the connection, and connects to it while it works', async () => {
    const { made, connectionId, finish } = await widened();
    expect(await finish('send')).toMatchObject({
      kind: 'ok',
      value: {
        kind: 'connected',
        request: { state: 'connected', connectionId },
        connection: { connectionId },
      },
    });
    expect(await made.binding.get({ tenantId, connectionId })).toMatchObject({
      permissions: ['gmail.send', 'gmail.readonly'],
      state: 'working',
    });
  });

  test('another account is refused before its grant is weighed, and the connection stays as it was', async () => {
    const { made, connectionId, finish } = await widened();
    expect(await finish('other')).toMatchObject({
      kind: 'err',
      error: { code: 'connection-account-mismatch' },
    });
    expect(await made.binding.get({ tenantId, connectionId })).toMatchObject({
      account: { id: 'g-ana' },
      permissions: ['gmail.send', 'gmail.readonly'],
      state: 'working',
    });
  });

  test('while it needs reconnecting: a grant lacking the new permission declines for it; one with it is stored', async () => {
    const { made, connectionId, finish } = await widened();
    await made.binding.receiveNotice({
      tenantId,
      appId: made.googleApp.appId,
      headers: {},
      rawBody: new TextEncoder().encode('{}'),
    });
    expect(await finish('send')).toMatchObject({
      kind: 'ok',
      value: { kind: 'declined', request: { state: 'declined', missing: ['gmail.readonly'] } },
    });
    expect(await made.binding.get({ tenantId, connectionId })).toMatchObject({
      state: 'needs-reconnecting',
    });
    expect(await finish('both', 1)).toMatchObject({
      kind: 'ok',
      value: { kind: 'connected', request: { state: 'connected', connectionId } },
    });
    expect(await made.binding.get({ tenantId, connectionId })).toMatchObject({
      permissions: ['gmail.send', 'gmail.readonly'],
      state: 'working',
    });
  });
});

describe("a GitHub App's connect", () => {
  const one = [{ installationId: '101', account: { id: '1', label: 'acme' } }];
  const two = [...one, { installationId: '102', account: { id: '2', label: 'acme-labs' } }];

  test('with no installation, the start goes to the install page; otherwise to authorization', async () => {
    let installs: typeof two = [];
    const made = setup({ installations: () => installs });
    const created = await request(made, {
      app: 'github',
      owner: 'company',
      permissions: ['issues.read'],
    });
    const install = await start(made, created.requestId, admin);
    expect(install.origin + install.pathname).toBe(
      'https://github.com/apps/acme-kindgi/installations/new',
    );
    installs = one;
    const authorize = await start(made, created.requestId, admin);
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('Iv1.acme');
    const another = await start(made, created.requestId, admin, { newInstallation: true });
    expect(another.pathname).toBe('/apps/acme-kindgi/installations/new');

    const state = another.searchParams.get('state') as string;
    const finished = await made.binding.finishRequest({
      tenantId,
      caller: admin,
      state,
      code: 'ok',
      installationId: '101',
      setupAction: 'install',
    });
    expect(finished).toMatchObject({
      kind: 'ok',
      value: {
        kind: 'connected',
        connection: {
          installationId: '101',
          account: { label: 'acme' },
          owner: { kind: 'company' },
        },
      },
    });
  });

  test('several reachable: pick one; none reachable: the request is named, to install on another', async () => {
    let installs: typeof two = two;
    const made = setup({ installations: () => installs });
    const created = await request(made, {
      app: 'github',
      owner: 'company',
      permissions: ['issues.read'],
    });
    const s1 = (await start(made, created.requestId, admin)).searchParams.get('state') as string;
    const pick = await made.binding.finishRequest({
      tenantId,
      caller: admin,
      state: s1,
      code: 'ok',
    });
    expect(pick).toMatchObject({
      kind: 'ok',
      value: { kind: 'pick-installation', request: { state: 'pending', installations: two } },
    });
    expect(pick.kind === 'ok' && pick.value.request.failure).toBe(undefined);

    const s2 = (
      await start(made, created.requestId, admin, { installationId: '102' })
    ).searchParams.get('state') as string;
    installs = one;
    const gone = await made.binding.finishRequest({
      tenantId,
      caller: admin,
      state: s2,
      code: 'ok',
    });
    expect(gone).toEqual({
      kind: 'err',
      error: {
        code: 'connection-installation-unreachable',
        message: expect.stringContaining('newInstallation'),
        connectRequestId: created.requestId,
      },
    });
    installs = two;
    const s3 = (
      await start(made, created.requestId, admin, { installationId: '102' })
    ).searchParams.get('state') as string;
    const picked = await made.binding.finishRequest({
      tenantId,
      caller: admin,
      state: s3,
      code: 'ok',
    });
    expect(picked).toMatchObject({
      kind: 'ok',
      value: {
        kind: 'connected',
        connection: { installationId: '102', account: { label: 'acme-labs' } },
      },
    });
    expect(picked.kind === 'ok' && picked.value.request.installations).toBe(undefined);
  });

  test('an install waiting for an organization owner fails, code or not, without an exchange', async () => {
    const made = setup({ installations: () => one });
    for (const code of [undefined, 'ok']) {
      const created = await request(made, {
        app: 'github',
        owner: 'company',
        permissions: ['issues.read'],
      });
      const state = (await start(made, created.requestId, admin)).searchParams.get('state');
      expect(
        await made.binding.finishRequest({
          tenantId,
          caller: admin,
          state: state as string,
          ...(code !== undefined && { code }),
          setupAction: 'request',
        }),
      ).toMatchObject({ kind: 'err', error: { code: 'connection-app-refused' } });
      expect(
        await made.binding.getRequest({ tenantId, requestId: created.requestId }),
      ).toMatchObject({ state: 'failed', failure: 'app-refused' });
    }
    expect(made.calls.filter((c) => c.op === 'exchange')).toEqual([]);

    // Only a GitHub App's finish reads it.
    const created = await request(made);
    const state = (await start(made, created.requestId)).searchParams.get('state');
    expect(
      await made.binding.finishRequest({
        tenantId,
        caller: ana,
        state: state as string,
        setupAction: 'request',
      }),
    ).toMatchObject({ kind: 'err', error: { code: 'bad-input' } });
  });

  test("the GitHub fields are a GitHub App's only, and never both", async () => {
    const made = setup();
    const mail = await request(made);
    for (const field of ['installationId', 'newInstallation'] as const) {
      const more =
        field === 'installationId' ? { installationId: '1' } : { newInstallation: true as const };
      expect(
        await made.binding.startRequest({
          tenantId,
          requestId: mail.requestId,
          caller: ana,
          ...more,
        }),
      ).toMatchObject({ kind: 'err', error: { code: 'bad-input', field } });
    }
    const repo = await request(made, {
      app: 'github',
      owner: 'company',
      permissions: ['issues.read'],
    });
    expect(
      await made.binding.startRequest({
        tenantId,
        requestId: repo.requestId,
        caller: admin,
        installationId: '1',
        newInstallation: true,
      }),
    ).toMatchObject({ kind: 'err', error: { code: 'bad-input', field: 'newInstallation' } });
  });
});

describe('disconnects, notices and lists', () => {
  test('a disconnect withdraws at the app once, unless another connection shares the grant', async () => {
    const withdraw = vi.fn<NonNullable<FakeApp['withdraw']>>(() => 'ok');
    const made = setup({ withdraw });
    const owner = { kind: 'member', userId: ana.id } as const;
    const account = { id: 'g-ana', label: 'ana@acme.example' };
    const mine = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner,
      account,
      permissions: ['gmail.send'],
    });
    const staging = made.seed.connection({
      tenantId,
      envName: 'staging' as EnvName,
      app: 'google',
      owner,
      account,
      permissions: ['gmail.send'],
    });
    const first = await made.binding.disconnect({
      tenantId,
      connectionId: mine.connectionId,
      by: ana,
    });
    expect(first).toMatchObject({
      kind: 'ok',
      value: {
        state: 'removed',
        withdrawn: 'kept-for-other-connection',
        removedBy: 'user:user-ana',
      },
    });
    expect(withdraw).not.toHaveBeenCalled();
    const last = await made.binding.disconnect({
      tenantId,
      connectionId: staging.connectionId,
      by: ana,
    });
    expect(last).toMatchObject({ kind: 'ok', value: { withdrawn: 'at-app' } });
    expect(withdraw).toHaveBeenCalledTimes(1);
    // Idempotent.
    expect(
      await made.binding.disconnect({ tenantId, connectionId: staging.connectionId, by: ana }),
    ).toMatchObject({ kind: 'ok', value: { withdrawn: 'at-app' } });
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  test('a notice is refused unless the fake app accepts it; an accepted one acts on its account', async () => {
    const plain = setup();
    const input = {
      tenantId,
      appId: plain.githubApp.appId,
      headers: {},
      rawBody: new TextEncoder().encode('{}'),
    };
    expect(await plain.binding.receiveNotice(input)).toMatchObject({
      kind: 'err',
      error: { code: 'connection-notice-invalid' },
    });
    const busy = setup({ notice: () => 'unavailable' });
    expect(
      await busy.binding.receiveNotice({ ...input, appId: busy.githubApp.appId }),
    ).toMatchObject({ kind: 'err', error: { code: 'connection-notice-unavailable' } });
    expect(busy.calls).toEqual([{ op: 'notice', outcome: 'unavailable' }]);

    const made = setup({
      notice: () => ({ handled: 'installation.deleted', accountId: '1', action: 'remove' }),
    });
    const repo = made.seed.connection({
      tenantId,
      envName,
      app: 'github',
      owner: { kind: 'company' },
      account: { id: '1', label: 'acme' },
      permissions: ['issues.read'],
      installationId: '101',
    });
    expect(await made.binding.receiveNotice({ ...input, appId: made.githubApp.appId })).toEqual({
      kind: 'ok',
      value: { handled: 'installation.deleted', connections: 1 },
    });
    expect(await made.binding.get({ tenantId, connectionId: repo.connectionId })).toMatchObject({
      state: 'removed',
      removedReason: 'uninstalled',
      withdrawn: 'at-app',
    });
  });

  test('a notice that needs a reconnect says why: suspended at GitHub, sessions revoked at Google', async () => {
    const made = setup({
      notice: ({ appId }) => ({
        handled: appId === made.githubApp.appId ? 'installation.suspend' : 'sessions-revoked',
        accountId: '1',
        action: 'needs-reconnecting',
      }),
    });
    const repo = made.seed.connection({
      tenantId,
      envName,
      app: 'github',
      owner: { kind: 'company' },
      account: { id: '1', label: 'acme' },
      permissions: ['issues.read'],
      installationId: '101',
    });
    const mail = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: ana.id },
      account: { id: '1', label: 'ana@acme.example' },
      permissions: ['gmail.send'],
    });
    const body = { headers: {}, rawBody: new TextEncoder().encode('{}') };
    for (const app of [made.githubApp, made.googleApp]) {
      expect(
        await made.binding.receiveNotice({ tenantId, appId: app.appId, ...body }),
      ).toMatchObject({ kind: 'ok', value: { connections: 1 } });
    }
    expect(await made.binding.get({ tenantId, connectionId: repo.connectionId })).toMatchObject({
      state: 'needs-reconnecting',
      stateReason: 'suspended',
    });
    expect(await made.binding.get({ tenantId, connectionId: mail.connectionId })).toMatchObject({
      state: 'needs-reconnecting',
      stateReason: 'sessions-revoked',
    });
  });

  test('lists filter and page', async () => {
    const made = setup();
    for (const userId of ['u-1', 'u-2', 'u-3']) {
      made.seed.connection({
        tenantId,
        envName,
        app: 'google',
        owner: { kind: 'member', userId },
        account: { id: userId, label: userId },
        permissions: ['gmail.send'],
      });
    }
    const first = await made.binding.list({ tenantId, limit: 2 });
    expect(first.data).toHaveLength(2);
    if (first.nextCursor === undefined) throw new Error('expected a next page');
    const rest = await made.binding.list({ tenantId, limit: 2, cursor: first.nextCursor });
    expect(rest.data).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    const hers = await made.binding.list({ tenantId, limit: 10, ownerUserId: 'u-2' });
    expect(hers.data.map((c) => c.account.id)).toEqual(['u-2']);
    const other = await made.binding.list({
      tenantId: '00000000-0000-4000-8000-0000000000bb' as TenantId,
      limit: 10,
    });
    expect(other.data).toEqual([]);
  });
});
