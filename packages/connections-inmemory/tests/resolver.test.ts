// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test, vi } from 'vitest';

import { computeConnectWaitToken } from '@kindgi/agents';
import type { PrincipalRef } from '@kindgi/authz';
import { github } from '@kindgi/connections/github';
import { google } from '@kindgi/connections/google';
import { type ConnectionNeed, isConnectionRenewError } from '@kindgi/tools';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import { type FakeApp, createInMemoryConnections } from '../src/index.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const projectId = '00000000-0000-4000-8000-0000000000a1' as ProjectId;
const envName = 'local' as EnvName;
const admin: PrincipalRef = { kind: 'user', id: 'user-admin', tenantId };
const SECRET = { envName, name: 'ACME_CLIENT_SECRET' };
const START = Date.parse('2026-10-22T12:00:00.000Z');
const mail: ConnectionNeed = { app: 'google', permissions: ['gmail.send'], as: 'person' };
const inbox: ConnectionNeed = { app: 'google', permissions: ['gmail.readonly'], as: 'person' };
const issues: ConnectionNeed = { app: 'github', permissions: ['issues.read'], as: 'company' };

function setup(app: FakeApp = {}) {
  let at = START;
  const onConnectComplete = vi.fn(async () => {});
  const made = createInMemoryConnections({
    entries: [google, github],
    publicUrl: 'https://kindgi.acme.example',
    now: () => at,
    app,
    onConnectComplete,
  });
  made.seed.app({
    tenantId,
    app: 'google',
    oauth2: { clientId: 'acme.apps.googleusercontent.com', clientSecret: SECRET },
    by: admin,
  });
  made.seed.app({
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
    projects: ['00000000-0000-4000-8000-0000000000a9' as ProjectId],
    by: admin,
  });
  const seedMail = (permissions = ['gmail.send']) =>
    made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: 'user-ana' },
      account: { id: 'g-ana', label: 'ana@acme.example' },
      permissions,
    });
  const resolve = (
    needs: Record<string, ConnectionNeed>,
    more: { waitMs?: number; person?: string | null; renew?: string[]; callId?: string } = {},
  ) =>
    made.resolver.resolveConnections({
      tenantId,
      projectId,
      envName,
      runId: 'run-1',
      callId: more.callId ?? 'call-1',
      toolId: 'acme.mail.send',
      needs,
      ...(more.person !== null && { person: { userId: more.person ?? 'user-ana' } }),
      waitMs: more.waitMs ?? 15 * 60_000,
      ...(more.renew !== undefined && { renew: more.renew }),
    });
  return {
    ...made,
    onConnectComplete,
    seedMail,
    resolve,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('ready', () => {
  test('a working connection with every permission gives its current token', async () => {
    const made = setup();
    const connection = made.seedMail(['gmail.send', 'gmail.readonly']);
    const first = await made.resolve({ mail, inbox });
    expect(first).toEqual({
      kind: 'ready',
      connections: {
        mail: {
          connectionId: connection.connectionId,
          app: 'google',
          appName: 'Google',
          accessToken: `fake-${connection.connectionId}-1`,
          account: { id: 'g-ana', label: 'ana@acme.example' },
          expiresAt: '2026-10-22T13:00:00.000Z',
        },
        inbox: expect.objectContaining({ accessToken: `fake-${connection.connectionId}-1` }),
      },
    });
    expect(made.calls).toEqual([]);
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({ lastUsedAt: '2026-10-22T12:00:00.000Z' });
  });

  test('renewed when asked, or within a minute of expiry', async () => {
    const made = setup();
    const connection = made.seedMail();
    const renewed = await made.resolve({ mail }, { renew: ['mail'] });
    expect(renewed.kind === 'ready' && renewed.connections.mail?.accessToken).toBe(
      `fake-${connection.connectionId}-2`,
    );
    made.advance(58 * 60_000);
    const kept = await made.resolve({ mail });
    expect(kept.kind === 'ready' && kept.connections.mail?.accessToken).toBe(
      `fake-${connection.connectionId}-2`,
    );
    made.advance(60_000);
    const near = await made.resolve({ mail });
    expect(near.kind === 'ready' && near.connections.mail?.accessToken).toBe(
      `fake-${connection.connectionId}-3`,
    );
    expect(made.calls.map((c) => c.op)).toEqual(['renew', 'renew']);
  });

  test("an app that can't renew just now throws, and the connection stays as it is", async () => {
    const made = setup({ renew: () => 'unavailable' });
    const connection = made.seedMail();
    const thrown = await made.resolve({ mail }, { renew: ['mail'] }).catch((e: unknown) => e);
    expect(isConnectionRenewError(thrown)).toBe(true);
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({ state: 'working' });
  });

  test('a withdrawn grant marks it needs-reconnecting, and the call waits for a reconnect', async () => {
    const made = setup({ renew: () => 'invalid-grant' });
    const connection = made.seedMail();
    const outcome = await made.resolve({ mail }, { renew: ['mail'] });
    expect(outcome).toMatchObject({ kind: 'wait', requests: [{ name: 'mail', reconnects: true }] });
    expect(
      await made.binding.get({ tenantId, connectionId: connection.connectionId }),
    ).toMatchObject({ state: 'needs-reconnecting', stateReason: 'invalid-grant' });
  });
});

describe('wait', () => {
  test('one request per connection, made once for the same call, for all its needs', async () => {
    const made = setup();
    const first = await made.resolve({ mail, inbox });
    const waitToken = computeConnectWaitToken({ runId: 'run-1', callId: 'call-1', name: 'inbox' });
    expect(first).toEqual({
      kind: 'wait',
      requests: [
        {
          name: 'inbox',
          requestId: expect.any(String),
          waitToken,
          app: 'google',
          appName: 'Google',
          says: ['Read your mail', 'Send mail as you'],
          connectUrl: expect.stringMatching(/^https:\/\/kindgi\.acme\.example\/console\/connect\//),
          expiresAt: '2026-10-22T12:15:00.000Z',
        },
      ],
    });
    const again = await made.resolve({ mail, inbox });
    expect(again).toEqual(first);
    const other = await made.resolve({ mail, inbox }, { callId: 'call-2' });
    expect(other.kind === 'wait' && other.requests[0]?.requestId).not.toBe(
      first.kind === 'wait' && first.requests[0]?.requestId,
    );
    expect(await made.binding.requestsForRun({ tenantId, runId: 'run-1' })).toHaveLength(2);
  });

  test('the finish completes the run’s wait, and the call is ready after', async () => {
    const made = setup();
    const waiting = await made.resolve({ mail });
    if (waiting.kind !== 'wait') throw new Error('expected a wait');
    const [request] = waiting.requests;
    const caller: PrincipalRef = { kind: 'user', id: 'user-ana', tenantId };
    const started = await made.binding.startRequest({
      tenantId,
      requestId: request?.requestId as string,
      caller,
    });
    const state =
      started.kind === 'ok' ? new URL(started.value.authorizeUrl).searchParams.get('state') : null;
    const finished = await made.binding.finishRequest({
      tenantId,
      caller,
      state: state as string,
      code: 'ok',
    });
    if (finished.kind !== 'ok' || finished.value.kind !== 'connected') {
      throw new Error('expected a connect');
    }
    expect(made.onConnectComplete).toHaveBeenCalledWith({
      tenantId,
      runId: 'run-1',
      waitToken: request?.waitToken,
      result: { kind: 'connected', connectionId: finished.value.connection.connectionId },
    });
    expect(await made.resolve({ mail })).toMatchObject({ kind: 'ready' });
  });

  test('a connection lacking a permission waits for a reconnect asking for both', async () => {
    const made = setup();
    made.seedMail(['gmail.readonly']);
    const outcome = await made.resolve({ mail });
    expect(outcome).toMatchObject({
      kind: 'wait',
      requests: [{ says: ['Send mail as you', 'Read your mail'], reconnects: true }],
    });
  });
});

describe('refused', () => {
  test('no registration lets the project connect', async () => {
    const made = setup();
    expect(await made.resolve({ issues })).toMatchObject({
      kind: 'refused',
      code: 'connection-app-missing',
      name: 'issues',
      app: 'github',
    });
  });

  test("a person's connection in a run with no person", async () => {
    const made = setup();
    expect(await made.resolve({ mail }, { person: null })).toMatchObject({
      kind: 'refused',
      code: 'connection-needs-a-person',
      name: 'mail',
    });
  });

  test("a call that can't wait, and the company's connection, fail with connection-missing", async () => {
    const made = setup();
    made.seedMail(['gmail.readonly']);
    expect(await made.resolve({ mail }, { waitMs: 0 })).toMatchObject({
      kind: 'refused',
      code: 'connection-missing',
      missing: ['gmail.send'],
    });
    const [repos] = (await made.binding.listApps({ tenantId, limit: 10 })).data.filter(
      (a) => a.app === 'github',
    );
    await made.binding.updateApp({
      tenantId,
      appId: repos?.appId as string,
      projects: null,
      by: admin,
    });
    expect(await made.resolve({ issues })).toMatchObject({
      kind: 'refused',
      code: 'connection-missing',
      name: 'issues',
      missing: ['issues.read'],
    });
    expect(await made.binding.requestsForRun({ tenantId, runId: 'run-1' })).toEqual([]);
  });
});
