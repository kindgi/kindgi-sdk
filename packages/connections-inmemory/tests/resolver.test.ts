// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test, vi } from 'vitest';

import { computeConnectWaitToken } from '@kindgi/agents';
import type { PrincipalRef } from '@kindgi/authz';
import { github } from '@kindgi/connections/github';
import { google } from '@kindgi/connections/google';
import {
  type ConnectionNeed,
  type ConnectionRunMailbox,
  type ConnectionTarget,
  isConnectionRenewError,
} from '@kindgi/tools';
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
    inProject: () => true,
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
    more: {
      waitMs?: number;
      person?: string | null;
      renew?: string[];
      callId?: string;
      target?: ConnectionTarget;
      mailbox?: ConnectionRunMailbox;
    } = {},
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
      ...(more.target !== undefined && { target: more.target }),
      ...(more.mailbox !== undefined && { mailbox: more.mailbox }),
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
          name: 'ana@acme.example',
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

describe('a company need', () => {
  const send: ConnectionNeed = { app: 'google', permissions: ['gmail.send'], as: 'company' };
  const agent: ConnectionTarget = { agentId: 'mail-helper' };
  const other = '00000000-0000-4000-8000-0000000000b2' as ProjectId;

  /** Two company Google connections: support (sends) and, made later, sales (reads only). */
  function company() {
    const made = setup();
    const add = (
      label: string | undefined,
      account: string,
      more: Partial<Parameters<typeof made.seed.connection>[0]> = {},
    ) =>
      made.seed.connection({
        tenantId,
        envName,
        app: 'google',
        owner: { kind: 'company' },
        account: { id: account, label: account },
        ...(label !== undefined && { label }),
        permissions: ['gmail.send'],
        ...more,
      }).connectionId;
    const support = add('support', 'support@acme.example', {
      permissions: ['gmail.send', 'gmail.readonly'],
    });
    const sales = add('sales', 'sales@acme.example', { permissions: ['gmail.readonly'] });
    const choose = async (connectionId: string, target: ConnectionTarget = agent) => {
      const set = await made.binding.setChoice({
        tenantId,
        projectId,
        envName,
        connectionId,
        by: admin,
        ...target,
      });
      if (set.kind !== 'ok') throw new Error(set.error.message);
      return set.value;
    };
    const used = async (more: Parameters<typeof made.resolve>[1] = {}) => {
      const answer = await made.resolve({ mail: send }, { person: null, ...more });
      return answer.kind === 'ready' ? answer.connections.mail?.connectionId : answer;
    };
    return { ...made, add, support, sales, choose, used };
  }

  const none = {
    kind: 'refused',
    code: 'connection-missing',
    name: 'mail',
    app: 'google',
    missing: ['gmail.send'],
    message: `"mail" needs a Google connection, and there's none`,
  };

  test('the only candidate, named; a person’s, another env’s or a removed one doesn’t count', async () => {
    const made = setup();
    made.seedMail();
    made.seed.connection({
      tenantId,
      envName: 'staging' as EnvName,
      app: 'google',
      owner: { kind: 'company' },
      account: { id: 'staging@acme.example', label: 'staging@acme.example' },
      permissions: ['gmail.send'],
    });
    made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'company' },
      account: { id: 'gone@acme.example', label: 'gone@acme.example' },
      permissions: ['gmail.send'],
      state: 'removed',
    });
    expect(await made.resolve({ mail: send }, { target: agent })).toEqual(none);
    const only = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'company' },
      account: { id: 'support@acme.example', label: 'support@acme.example' },
      label: 'support',
      permissions: ['gmail.send'],
    });
    expect(await made.resolve({ mail: send }, { target: agent })).toMatchObject({
      kind: 'ready',
      connections: { mail: { connectionId: only.connectionId, name: 'support' } },
    });
  });

  test('several and no choice: connection-not-chosen, sorted by name, counted before permissions', async () => {
    const made = company();
    const refused = {
      kind: 'refused',
      code: 'connection-not-chosen',
      name: 'mail',
      app: 'google',
      choices: [
        { connectionId: made.sales, name: 'sales' },
        { connectionId: made.support, name: 'support' },
      ],
    };
    // Only support holds gmail.send, and it still isn't picked.
    expect(await made.used({ target: agent })).toEqual({
      ...refused,
      message:
        'This project has 2 company Google connections (sales, support), and agent mail-helper has no choice of one. A project admin chooses it: Project, Agents, mail-helper, Connections, or kindgi connection-choices set.',
    });
    expect(await made.used({ target: { flowId: 'triage' } })).toEqual({
      ...refused,
      message:
        'This project has 2 company Google connections (sales, support), and flow triage has no choice of one. A project admin chooses it: Project, Flows, triage, Connections, or kindgi connection-choices set.',
    });
    expect(await made.used()).toMatchObject({ code: 'connection-not-chosen' });
    // Another agent's choice, a flow's of the same id, or one in another project isn't this one's.
    await made.choose(made.support, { agentId: 'other-agent' });
    await made.choose(made.support, { flowId: 'mail-helper' });
    expect(await made.used({ target: agent })).toMatchObject({ code: 'connection-not-chosen' });
  });

  test('a candidate that needs reconnecting still counts, so the other is never a silent pick', async () => {
    const made = setup();
    for (const [account, state] of [
      ['support@acme.example', 'working'],
      ['old@acme.example', 'needs-reconnecting'],
    ] as const) {
      made.seed.connection({
        tenantId,
        envName,
        app: 'google',
        owner: { kind: 'company' },
        account: { id: account, label: account },
        permissions: ['gmail.send'],
        state,
      });
    }
    expect(await made.resolve({ mail: send }, { target: agent })).toMatchObject({
      code: 'connection-not-chosen',
      choices: [{ name: 'old@acme.example' }, { name: 'support@acme.example' }],
    });
  });

  test("the agent's choice, and a flow's", async () => {
    const made = company();
    await made.choose(made.support);
    expect(await made.used({ target: agent })).toBe(made.support);
    const salesHelper = made.add('sales-2', 'sales2@acme.example');
    await made.choose(salesHelper, { flowId: 'triage' });
    expect(await made.used({ target: { flowId: 'triage' } })).toBe(salesHelper);
    expect(await made.used({ target: agent })).toBe(made.support);
  });

  test("the run's mailbox beats a choice; a person's mailbox, another app's or one with no id doesn't", async () => {
    const made = company();
    const inbox: ConnectionNeed = { app: 'google', permissions: ['gmail.readonly'], as: 'company' };
    await made.choose(made.support);
    const read = async (mailbox: ConnectionRunMailbox) => {
      const answer = await made.resolve({ inbox }, { person: null, target: agent, mailbox });
      return answer.kind === 'ready' ? answer.connections.inbox?.connectionId : answer;
    };
    expect(await read({ app: 'google', as: 'company', connectionId: made.sales })).toBe(made.sales);
    expect(await read({ app: 'google', as: 'person', connectionId: made.sales })).toBe(
      made.support,
    );
    expect(await read({ app: 'microsoft', as: 'company', connectionId: made.sales })).toBe(
      made.support,
    );
    expect(await read({ app: 'google', as: 'company' })).toBe(made.support);
  });

  test('a choice that lacks the permission, or needs reconnecting, never falls back to the only other', async () => {
    const made = company();
    await made.choose(made.sales);
    expect(await made.used({ target: agent })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'mail',
      app: 'google',
      missing: ['gmail.send'],
      message: 'sales (sales@acme.example) lacks gmail.send; reconnect it, or choose another',
    });
    const reconnect = made.add('old', 'old@acme.example', { state: 'needs-reconnecting' });
    await made.choose(reconnect);
    expect(await made.used({ target: agent })).toMatchObject({
      code: 'connection-missing',
      message: 'old (old@acme.example) needs reconnecting; reconnect it, or choose another',
    });
  });

  test('a choice disconnected, or on a registration that no longer allows the project, never falls back to the only other', async () => {
    const made = company();
    await made.choose(made.support);
    await made.binding.disconnect({ tenantId, connectionId: made.support, by: admin });
    // sales is now the only candidate, and still isn't taken.
    expect(await made.used({ target: agent })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'mail',
      app: 'google',
      message: 'support (support@acme.example) was disconnected; choose another',
    });
    const [first] = (await made.binding.listApps({ tenantId, limit: 10 })).data.filter(
      (a) => a.app === 'google',
    );
    const narrow = made.add('narrow', 'narrow@acme.example');
    await made.choose(narrow);
    expect(await made.used({ target: agent })).toBe(narrow);
    await made.binding.updateApp({
      tenantId,
      appId: first?.appId as string,
      projects: [other],
      by: admin,
    });
    const next = made.seed.app({
      tenantId,
      app: 'google',
      oauth2: { clientId: 'next.apps.googleusercontent.com', clientSecret: SECRET },
      projects: [projectId],
      by: admin,
    });
    const billing = made.add('billing', 'billing@acme.example', { appId: next.appId });
    expect(await made.used()).toBe(billing);
    expect(await made.used({ target: agent })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'mail',
      app: 'google',
      message:
        'narrow (narrow@acme.example) is on a Google registration that no longer allows this project; choose another',
    });
  });

  test("the mailbox's connection in another env, removed or lacking, refuses naming it", async () => {
    const made = company();
    const staging = made.add('staging', 'staging@acme.example', { envName: 'staging' as EnvName });
    const mailbox = (connectionId: string): ConnectionRunMailbox => ({
      app: 'google',
      as: 'company',
      connectionId,
    });
    await made.choose(made.support);
    expect(await made.used({ target: agent, mailbox: mailbox(staging) })).toMatchObject({
      code: 'connection-missing',
      message:
        'staging (staging@acme.example), the mailbox this run reads, is in env staging, not local',
    });
    expect(await made.used({ target: agent, mailbox: mailbox(made.sales) })).toMatchObject({
      code: 'connection-missing',
      missing: ['gmail.send'],
      message:
        'sales (sales@acme.example), the mailbox this run reads, lacks gmail.send; reconnect it',
    });
    await made.binding.disconnect({ tenantId, connectionId: made.sales, by: admin });
    expect(await made.used({ target: agent, mailbox: mailbox(made.sales) })).toMatchObject({
      code: 'connection-missing',
      message: 'sales (sales@acme.example), the mailbox this run reads, was disconnected',
    });
  });

  test("an id that isn't the company's connection of the app answers as no connection does", async () => {
    const made = company();
    const ana = made.seedMail();
    const github = made.add(undefined, 'acme', { app: 'github', permissions: ['issues.read'] });
    for (const connectionId of ['00000000-0000-4000-8000-00000000dead', ana.connectionId, github]) {
      expect(
        await made.used({
          target: agent,
          mailbox: { app: 'google', as: 'company', connectionId },
        }),
      ).toEqual(none);
    }
  });

  test("a person's need is unchanged by a mailbox or a choice", async () => {
    const made = company();
    const ana = made.seedMail();
    await made.choose(made.support);
    const answer = await made.resolve(
      { mail },
      { target: agent, mailbox: { app: 'google', as: 'company', connectionId: made.support } },
    );
    expect(answer.kind === 'ready' && answer.connections.mail?.connectionId).toBe(ana.connectionId);
  });
});
