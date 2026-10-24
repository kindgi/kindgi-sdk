// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test, vi } from 'vitest';

import type { PrincipalRef } from '@kindgi/authz';
import type { AppEntry, SignIn } from '@kindgi/connections';
import { google } from '@kindgi/connections/google';
import type { ConnectionNeed } from '@kindgi/tools';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import { type FakeApp, createInMemoryConnections } from '../src/index.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const projectId = '00000000-0000-4000-8000-0000000000a1' as ProjectId;
const envName = 'local' as EnvName;
const ana: PrincipalRef = { kind: 'user', id: 'user-ana', tenantId };
const admin: PrincipalRef = { kind: 'user', id: 'user-admin', tenantId };
const SECRET = { envName, name: 'ACME_CLIENT_SECRET' };
const START = Date.parse('2026-10-22T12:00:00.000Z');

/** An app that may give no refresh token: Google's entry, as `acme`, with `refreshToken: 'optional'`. */
const acme: AppEntry = {
  ...google,
  id: 'acme',
  name: 'Acme',
  signIn: { ...(google.signIn as Extract<SignIn, { kind: 'oauth2' }>), refreshToken: 'optional' },
};
const post: ConnectionNeed = { app: 'acme', permissions: ['gmail.send'], as: 'person' };

function setup(app: FakeApp = {}) {
  let at = START;
  const made = createInMemoryConnections({
    entries: [google, acme],
    publicUrl: 'https://kindgi.acme.example',
    now: () => at,
    app,
    onConnectComplete: vi.fn(async () => {}),
  });
  for (const id of ['google', 'acme']) {
    made.seed.app({
      tenantId,
      app: id,
      oauth2: { clientId: `${id}-client`, clientSecret: SECRET },
      by: admin,
    });
  }
  const seedPost = (refreshToken?: boolean) =>
    made.seed.connection({
      tenantId,
      envName,
      app: 'acme',
      owner: { kind: 'member', userId: ana.id },
      account: { id: ana.id, label: 'ana@acme.example' },
      permissions: ['gmail.send'],
      ...(refreshToken !== undefined && { refreshToken }),
    });
  const resolve = (more: { renew?: string[]; waitMs?: number; need?: ConnectionNeed } = {}) =>
    made.resolver.resolveConnections({
      tenantId,
      projectId,
      envName,
      runId: 'run-1',
      callId: 'call-1',
      toolId: 'acme.post',
      needs: { post: more.need ?? post },
      person: { userId: ana.id },
      waitMs: more.waitMs ?? 15 * 60_000,
      ...(more.renew !== undefined && { renew: more.renew }),
    });
  /** A connect of ana's own account, finished with code `ok`. */
  const connect = async (appId: string) => {
    const created = await made.binding.createRequest({
      tenantId,
      envName,
      app: appId,
      owner: { kind: 'member', userId: ana.id },
      permissions: ['gmail.send'],
      by: ana,
    });
    if (created.kind !== 'ok') throw new Error(created.error.message);
    const started = await made.binding.startRequest({
      tenantId,
      requestId: created.value.requestId,
      caller: ana,
    });
    if (started.kind !== 'ok') throw new Error(started.error.message);
    const state = new URL(started.value.authorizeUrl).searchParams.get('state') as string;
    const finished = await made.binding.finishRequest({ tenantId, caller: ana, state, code: 'ok' });
    return { requestId: created.value.requestId, finished };
  };
  return {
    ...made,
    seedPost,
    resolve,
    connect,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('a connection the app gave no refresh token', () => {
  test('works until its token ends, then needs reconnecting, with no call to the app', async () => {
    const made = setup();
    const connection = made.seedPost(false);
    expect(connection).toMatchObject({
      state: 'working',
      accessEndsAt: '2026-10-22T13:00:00.000Z',
    });
    const first = await made.resolve();
    expect(first.kind === 'ready' && first.connections.post?.accessToken).toBe(
      `fake-${connection.connectionId}-1`,
    );
    made.advance(58 * 60_000);
    const kept = await made.resolve();
    expect(kept.kind === 'ready' && kept.connections.post?.accessToken).toBe(
      `fake-${connection.connectionId}-1`,
    );
    made.advance(60_000);
    expect(await made.resolve()).toMatchObject({
      kind: 'wait',
      requests: [{ name: 'post', reconnects: true }],
    });
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({
      state: 'needs-reconnecting',
      stateReason: 'access-expired',
      accessEndsAt: '2026-10-22T13:00:00.000Z',
    });
    expect(made.calls).toEqual([]);
  });

  test('asked to renew, it needs reconnecting (invalid-grant), and a call that cannot wait is refused', async () => {
    const made = setup();
    const connection = made.seedPost(false);
    expect(await made.resolve({ renew: ['post'], waitMs: 0 })).toMatchObject({
      kind: 'refused',
      code: 'connection-missing',
    });
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({ state: 'needs-reconnecting', stateReason: 'invalid-grant' });
    expect(made.calls).toEqual([]);
  });

  test('one that renews has no accessEndsAt', async () => {
    const made = setup();
    const connection = made.seedPost();
    expect(connection.accessEndsAt).toBeUndefined();
    expect(() =>
      made.seed.connection({
        tenantId,
        envName,
        app: 'google',
        owner: { kind: 'member', userId: ana.id },
        account: { id: ana.id, label: 'ana@acme.example' },
        permissions: ['gmail.send'],
        refreshToken: false,
      }),
    ).toThrow(/Google gives refresh tokens/);
  });
  test('a get says it needs reconnecting from a minute before its token ends, with no run', async () => {
    const made = setup();
    const connection = made.seedPost(false);
    made.advance(58 * 60_000);
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({ state: 'working' });
    made.advance(60_000);
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({ state: 'needs-reconnecting', stateReason: 'access-expired' });
    expect(made.calls).toEqual([]);
  });

  test('so does a list, and its state filter goes by it', async () => {
    const made = setup();
    const connection = made.seedPost(false);
    const byState = async (state: 'working' | 'needs-reconnecting') =>
      (await made.binding.list({ tenantId, state, limit: 10 })).data.map((c) => c.connectionId);
    made.advance(58 * 60_000);
    expect(await byState('working')).toEqual([connection.connectionId]);
    made.advance(60_000);
    expect(await byState('working')).toEqual([]);
    expect(await byState('needs-reconnecting')).toEqual([connection.connectionId]);
    expect(made.calls).toEqual([]);
  });

  test('asked to renew in its last minute, it needs reconnecting as access-expired', async () => {
    const made = setup();
    const connection = made.seedPost(false);
    made.advance(59 * 60_000);
    expect(await made.resolve({ renew: ['post'], waitMs: 0 })).toMatchObject({
      kind: 'refused',
      code: 'connection-missing',
    });
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({ state: 'needs-reconnecting', stateReason: 'access-expired' });
    expect(made.calls).toEqual([]);
  });
});

describe('a finish whose code gives no refresh token', () => {
  test("where the entry requires one, it's refused and nothing is stored", async () => {
    const made = setup({
      exchange: () => ({ account: { id: ana.id, label: 'ana' }, refreshToken: false }),
    });
    const { requestId, finished } = await made.connect('google');
    expect(finished).toMatchObject({ kind: 'err', error: { code: 'connection-app-refused' } });
    expect(await made.binding.getRequest({ tenantId, requestId })).toMatchObject({
      state: 'failed',
      failure: 'app-refused',
    });
    expect((await made.binding.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test("where it's optional, the connection ends with its token; a reconnect that gives one renews", async () => {
    let refreshToken = false;
    const made = setup({
      exchange: () => ({ account: { id: ana.id, label: 'ana' }, refreshToken }),
    });
    const first = await made.connect('acme');
    expect(first.finished).toMatchObject({
      kind: 'ok',
      value: { kind: 'connected', connection: { accessEndsAt: '2026-10-22T13:00:00.000Z' } },
    });
    made.advance(59 * 60_000);
    expect(await made.resolve()).toMatchObject({ kind: 'wait' });

    refreshToken = true;
    const again = await made.connect('acme');
    expect(again.finished).toMatchObject({ kind: 'ok', value: { kind: 'connected' } });
    const connection =
      again.finished.kind === 'ok' && 'connection' in again.finished.value
        ? again.finished.value.connection
        : undefined;
    expect(connection).toMatchObject({ state: 'working' });
    expect(connection?.stateReason).toBeUndefined();
    expect(connection?.accessEndsAt).toBeUndefined();
    made.advance(59 * 60_000);
    expect(await made.resolve()).toMatchObject({ kind: 'ready' });
    expect(made.calls.map((c) => c.op)).toEqual(['exchange', 'exchange', 'renew']);
  });

  test('a reconnect without one keeps the refresh token the connection had', async () => {
    let refreshToken = true;
    const made = setup({
      exchange: () => ({ account: { id: ana.id, label: 'ana' }, refreshToken }),
    });
    await made.connect('google');
    refreshToken = false;
    const again = await made.connect('google');
    expect(again.finished).toMatchObject({ kind: 'ok', value: { kind: 'connected' } });
    const [connection] = (await made.binding.list({ tenantId, limit: 10 })).data;
    expect(connection?.accessEndsAt).toBeUndefined();
    made.advance(59 * 60_000);
    const mail: ConnectionNeed = { app: 'google', permissions: ['gmail.send'], as: 'person' };
    expect(await made.resolve({ need: mail })).toMatchObject({ kind: 'ready' });
    expect(made.calls.map((c) => c.op)).toEqual(['exchange', 'exchange', 'renew']);
  });

  test("where it's optional but the answer doesn't say when the token ends, it's refused", async () => {
    const made = setup({
      exchange: () => ({
        account: { id: ana.id, label: 'ana' },
        refreshToken: false,
        expiresIn: false,
      }),
    });
    const { requestId, finished } = await made.connect('acme');
    expect(finished).toMatchObject({
      kind: 'err',
      error: { code: 'connection-app-refused', message: expect.stringContaining('expires_in') },
    });
    expect(await made.binding.getRequest({ tenantId, requestId })).toMatchObject({
      state: 'failed',
      failure: 'app-refused',
    });
    expect((await made.binding.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test('one that gives a refresh token needs no expires_in', async () => {
    const made = setup({
      exchange: () => ({ account: { id: ana.id, label: 'ana' }, expiresIn: false }),
    });
    const { finished } = await made.connect('acme');
    expect(finished).toMatchObject({ kind: 'ok', value: { kind: 'connected' } });
  });
});
