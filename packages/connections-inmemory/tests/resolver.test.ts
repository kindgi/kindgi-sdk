// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test, vi } from 'vitest';

import { computeConnectWaitToken } from '@kindgi/agents';
import type { PrincipalRef } from '@kindgi/authz';
import { github } from '@kindgi/connections/github';
import { google } from '@kindgi/connections/google';
import {
  type ConnectionAccountChoicesInput,
  type ConnectionNeed,
  type ConnectionPick,
  type ConnectionRunMailbox,
  type ConnectionTarget,
  type ResolveConnectionsOutcome,
  isConnectionRenewError,
} from '@kindgi/tools';
import type { EnvName, ProjectId, TenantId, ToolId } from '@kindgi/types';

import { type FakeApp, type TargetTool, createInMemoryConnections } from '../src/index.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const projectId = '00000000-0000-4000-8000-0000000000a1' as ProjectId;
const envName = 'local' as EnvName;
const admin: PrincipalRef = { kind: 'user', id: 'user-admin', tenantId };
const SECRET = { envName, name: 'ACME_CLIENT_SECRET' };
const START = Date.parse('2026-10-22T12:00:00.000Z');
const mail: ConnectionNeed = { app: 'google', permissions: ['gmail.send'], as: 'person' };
const inbox: ConnectionNeed = { app: 'google', permissions: ['gmail.readonly'], as: 'person' };
const issues: ConnectionNeed = { app: 'github', permissions: ['issues.read'], as: 'company' };

/** The call's tool as its agent or flow resolves it now: `acme.mail.send`, a read tool. */
function tool(needs: Record<string, ConnectionNeed>, more: Partial<TargetTool> = {}): TargetTool {
  return {
    id: 'acme.mail.send' as ToolId,
    mutating: false,
    input: { type: 'object' },
    needsSpec: { connections: needs },
    ...more,
  };
}

/** A ready answer's connection for each need, and how it was picked, but not the registration. */
function picked(answer: ResolveConnectionsOutcome) {
  if (answer.kind !== 'ready') return answer;
  const { connections, picks } = answer;
  return Object.fromEntries(
    Object.entries(connections).map(([name, c]) => {
      const { registration: _registration, ...pick } = picks?.[name] as ConnectionPick;
      return [name, { connectionId: c.connectionId, ...pick }];
    }),
  );
}

function setup(app: FakeApp = {}) {
  let at = START;
  // Every agent's and flow's tools: a test sets them (`retool`).
  let tools: readonly TargetTool[] = [];
  const onConnectComplete = vi.fn(async () => {});
  const made = createInMemoryConnections({
    entries: [google, github],
    publicUrl: 'https://kindgi.acme.example',
    now: () => at,
    app,
    onConnectComplete,
    inProject: () => true,
    toolsOf: () => ({ tools }),
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
      toolId?: string;
      accounts?: Record<string, string>;
    } = {},
  ) =>
    made.resolver.resolveConnections({
      tenantId,
      projectId,
      envName,
      runId: 'run-1',
      callId: more.callId ?? 'call-1',
      toolId: more.toolId ?? 'acme.mail.send',
      needs,
      ...(more.person !== null && { person: { userId: more.person ?? 'user-ana' } }),
      waitMs: more.waitMs ?? 15 * 60_000,
      ...(more.renew !== undefined && { renew: more.renew }),
      ...(more.target !== undefined && { target: more.target }),
      ...(more.mailbox !== undefined && { mailbox: more.mailbox }),
      ...(more.accounts !== undefined && { accounts: more.accounts }),
    });
  return {
    ...made,
    onConnectComplete,
    seedMail,
    resolve,
    advance: (ms: number) => {
      at += ms;
    },
    retool: (next: readonly TargetTool[]) => {
      tools = next;
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
      picks: {
        mail: {
          by: 'own',
          as: 'person',
          registration: expect.objectContaining({ name: expect.any(String) }),
        },
        inbox: {
          by: 'own',
          as: 'person',
          registration: expect.objectContaining({ name: expect.any(String) }),
        },
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
    const answer = await made.resolve({ mail: send }, { target: agent });
    expect(answer).toMatchObject({
      kind: 'ready',
      connections: { mail: { connectionId: only.connectionId, name: 'support' } },
    });
    // Picked as the only one, with no choice, through the project's registration.
    const google = (await made.binding.listApps({ tenantId, limit: 10 })).data.find(
      (a) => a.app === 'google',
    );
    expect(answer.kind === 'ready' && answer.picks).toEqual({
      mail: {
        by: 'only',
        as: 'company',
        registration: { id: google?.appId, name: `Google (${google?.appId.slice(0, 8)})` },
      },
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
      message: 'sales lacks gmail.send; reconnect it, or choose another',
    });
    const reconnect = made.add('old', 'old@acme.example', { state: 'needs-reconnecting' });
    await made.choose(reconnect);
    expect(await made.used({ target: agent })).toMatchObject({
      code: 'connection-missing',
      message: 'old needs reconnecting; reconnect it, or choose another',
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
      message: 'support was disconnected; choose another',
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
        'narrow is on a Google registration that no longer allows this project; choose another',
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
      message: 'staging, the mailbox this run reads, is in env staging, not local',
    });
    expect(await made.used({ target: agent, mailbox: mailbox(made.sales) })).toMatchObject({
      code: 'connection-missing',
      missing: ['gmail.send'],
      message: 'sales, the mailbox this run reads, lacks gmail.send; reconnect it',
    });
    await made.binding.disconnect({ tenantId, connectionId: made.sales, by: admin });
    expect(await made.used({ target: agent, mailbox: mailbox(made.sales) })).toMatchObject({
      code: 'connection-missing',
      message: 'sales, the mailbox this run reads, was disconnected',
    });
  });

  test("a refusal names a connection by its name alone, a name that is its account's label too", async () => {
    const made = company();
    const desk = made.add('desk@acme.example', 'desk@acme.example');
    await made.choose(desk);
    await made.binding.disconnect({ tenantId, connectionId: desk, by: admin });
    expect(await made.used({ target: agent })).toMatchObject({
      code: 'connection-missing',
      message: 'desk@acme.example was disconnected; choose another',
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

  test("a ready answer says how each was picked, and through which registration: a person's as their own", async () => {
    const made = company();
    made.seedMail();
    const choice = await made.choose(made.support);
    const google = (await made.binding.listApps({ tenantId, limit: 10 })).data.find(
      (a) => a.app === 'google',
    );
    const registration = {
      id: google?.appId,
      name: `Google (${google?.appId.slice(0, 8)})`,
    };
    const inbox: ConnectionNeed = { app: 'google', permissions: ['gmail.readonly'], as: 'company' };
    const picksOf = async (more: Parameters<typeof made.resolve>[1]) => {
      const answer = await made.resolve({ mail, outbox: send, inbox }, more);
      return answer.kind === 'ready' ? answer.picks : answer;
    };
    expect(await picksOf({ target: agent })).toEqual({
      mail: { by: 'own', as: 'person', registration },
      outbox: { by: 'choice', choiceId: choice.choiceId, as: 'company', registration },
      inbox: { by: 'choice', choiceId: choice.choiceId, as: 'company', registration },
    });
    const mailbox: ConnectionRunMailbox = {
      app: 'google',
      as: 'company',
      connectionId: made.sales,
    };
    const read = await made.resolve({ inbox }, { person: null, target: agent, mailbox });
    expect(read.kind === 'ready' && read.picks).toEqual({
      inbox: { by: 'mailbox', as: 'company', registration },
    });
  });
});

describe("a person's need, with several of their connections", () => {
  const agent: ConnectionTarget = { agentId: 'mail-helper' };
  const ana: PrincipalRef = { kind: 'user', id: 'user-ana', tenantId };
  const ben: PrincipalRef = { kind: 'user', id: 'user-ben', tenantId };
  const outbox: ConnectionNeed = { app: 'google', permissions: ['gmail.send'], as: 'person' };

  /** Ana's Google connections: Work (sends and reads) and, made later, School (reads only). */
  function person() {
    const made = setup();
    const add = (
      label: string,
      account: string,
      more: Partial<Parameters<typeof made.seed.connection>[0]> = {},
    ) =>
      made.seed.connection({
        tenantId,
        envName,
        app: 'google',
        owner: { kind: 'member', userId: ana.id },
        account: { id: account, label: account },
        label,
        permissions: ['gmail.send', 'gmail.readonly'],
        ...more,
      }).connectionId;
    const work = add('Work', 'ana@acme.example');
    const school = add('School', 'ana@school.acme.example', { permissions: ['gmail.readonly'] });
    /** Their own choice for the agent, or for a tool's need with `toolId`. */
    const choose = async (
      connectionId: string,
      more: { toolId?: string; connectionIds?: string[]; by?: PrincipalRef } = {},
    ) => {
      const { by = ana, ...rest } = more;
      const set = await made.binding.setChoice({
        tenantId,
        projectId,
        envName,
        ...agent,
        connectionId,
        person: { userId: by.id },
        by,
        ...rest,
      });
      if (set.kind !== 'ok') throw new Error(set.error.message);
      return set.value;
    };
    const main = async (connectionId: string) => {
      const updated = await made.binding.update({ tenantId, connectionId, main: true, by: ana });
      if (updated.kind !== 'ok') throw new Error(updated.error.message);
    };
    return { ...made, add, work, school, choose, main };
  }

  test('several and none their main: connection-not-chosen counts them and names none', async () => {
    const made = person();
    const refused = {
      kind: 'refused',
      code: 'connection-not-chosen',
      name: 'inbox',
      app: 'google',
    };
    expect(await made.resolve({ inbox }, { target: agent })).toEqual({
      ...refused,
      message:
        'This person has 2 Google connections that could be used, and none is their main: they make one their main, or choose one for this agent.',
    });
    expect(await made.resolve({ inbox }, { target: { flowId: 'triage' } })).toEqual({
      ...refused,
      message:
        'This person has 2 Google connections that could be used, and none is their main: they make one their main, or choose one for this flow.',
    });
    expect(await made.resolve({ inbox })).toEqual({
      ...refused,
      message:
        'This person has 2 Google connections that could be used, and none is their main: they make one their main.',
    });
    // Another person's, the company's and a removed one of theirs don't count.
    made.add('Ben', 'ben@acme.example', { owner: { kind: 'member', userId: ben.id } });
    made.add('Desk', 'desk@acme.example', { owner: { kind: 'company' } });
    made.add('Old', 'ana@old.acme.example', { state: 'removed' });
    expect(await made.resolve({ inbox }, { target: agent })).toMatchObject({
      code: 'connection-not-chosen',
      message: expect.stringMatching(/^This person has 2 Google connections/),
    });
  });

  test('their main, else their only one: picked as their main, or as their own', async () => {
    const made = person();
    await made.main(made.school);
    const asMain = { inbox: { connectionId: made.school, by: 'main', as: 'person' } };
    expect(picked(await made.resolve({ inbox }, { target: agent }))).toEqual(asMain);
    expect(picked(await made.resolve({ inbox }))).toEqual(asMain);
    await made.binding.disconnect({ tenantId, connectionId: made.school, by: ana });
    expect(picked(await made.resolve({ inbox }, { target: agent }))).toEqual({
      inbox: { connectionId: made.work, by: 'own', as: 'person' },
    });
  });

  test("their own choice beats their main: the tool's, else the agent's; another person's is theirs alone", async () => {
    const made = person();
    made.retool([tool({ inbox })]);
    await made.main(made.work);
    const agentWide = await made.choose(made.school);
    const call = async (more: Parameters<typeof made.resolve>[1] = {}) =>
      picked(await made.resolve({ inbox }, { target: agent, ...more }));
    const byChoice = (connectionId: string, choiceId: string) => ({
      inbox: { connectionId, by: 'choice', choiceId, as: 'person' },
    });
    expect(await call()).toEqual(byChoice(made.school, agentWide.choiceId));
    const forTool = await made.choose(made.work, { toolId: 'acme.mail.send' });
    expect(forTool).toMatchObject({
      toolId: 'acme.mail.send',
      need: 'inbox',
      person: { userId: ana.id },
    });
    expect(await call()).toEqual(byChoice(made.work, forTool.choiceId));
    expect(await call({ toolId: 'acme.mail.read' })).toMatchObject({
      inbox: { connectionId: made.school, choiceId: agentWide.choiceId },
    });
    const bens = made.add('Ben', 'ben@acme.example', { owner: { kind: 'member', userId: ben.id } });
    made.add('Ben 2', 'ben@home.acme.example', { owner: { kind: 'member', userId: ben.id } });
    const bensChoice = await made.choose(bens, { by: ben });
    expect(await call({ person: ben.id })).toEqual(byChoice(bens, bensChoice.choiceId));
    expect(await call()).toMatchObject({ inbox: { connectionId: made.work } });
  });

  test('a refusal of their connection says whose it is, never its name, and how to fix it', async () => {
    const made = person();
    await made.main(made.school);
    // School lacks gmail.send: a call that can't wait is refused; one that can waits to reconnect.
    expect(await made.resolve({ outbox }, { target: agent, waitMs: 0 })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'outbox',
      app: 'google',
      missing: ['gmail.send'],
      message: `"outbox"'s Google connection lacks gmail.send; reconnect it`,
    });
    expect(await made.resolve({ outbox }, { target: agent })).toMatchObject({
      kind: 'wait',
      requests: [{ name: 'outbox', reconnects: true }],
    });
    await made.choose(made.school);
    expect(await made.resolve({ outbox }, { target: agent, waitMs: 0 })).toMatchObject({
      code: 'connection-missing',
      message: `"outbox"'s Google connection lacks gmail.send; reconnect it, or choose another`,
    });
    await made.binding.disconnect({ tenantId, connectionId: made.school, by: ana });
    expect(await made.resolve({ outbox }, { target: agent })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'outbox',
      app: 'google',
      message: `"outbox"'s Google connection was disconnected; choose another`,
    });
    const mailbox: ConnectionRunMailbox = {
      app: 'google',
      as: 'person',
      connectionId: made.school,
    };
    expect(await made.resolve({ inbox }, { target: agent, mailbox })).toMatchObject({
      code: 'connection-missing',
      message: 'The Google mailbox this run reads was disconnected',
    });
  });

  test("the run's mailbox, when it's their own, binds their need before their choice or their main", async () => {
    const made = person();
    await made.main(made.work);
    await made.choose(made.work);
    const read = async (mailbox: ConnectionRunMailbox) =>
      picked(await made.resolve({ inbox }, { target: agent, mailbox }));
    expect(await read({ app: 'google', as: 'person', connectionId: made.school })).toEqual({
      inbox: { connectionId: made.school, by: 'mailbox', as: 'person' },
    });
    // The company's mailbox, or one storing none, leaves it to their choice.
    for (const mailbox of [
      { app: 'google', as: 'company', connectionId: made.school },
      { app: 'google', as: 'person' },
    ] as const) {
      expect(await read(mailbox)).toMatchObject({
        inbox: { connectionId: made.work, by: 'choice' },
      });
    }
    // Another person's connection answers as none does.
    const bens = made.add('Ben', 'ben@acme.example', { owner: { kind: 'member', userId: ben.id } });
    expect(await read({ app: 'google', as: 'person', connectionId: bens })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'inbox',
      app: 'google',
      missing: ['gmail.readonly'],
      message: `"inbox" needs a Google connection, and there's none`,
    });
  });

  test('needs one connection serves share it: one ready connection, or one connect for them all', async () => {
    const made = person();
    await made.main(made.school);
    const waiting = await made.resolve({ inbox, mail, outbox }, { target: agent });
    expect(waiting).toMatchObject({ kind: 'wait', requests: [{ name: 'mail', reconnects: true }] });
    expect(waiting.kind === 'wait' && waiting.requests).toHaveLength(1);
    await made.main(made.work);
    expect(picked(await made.resolve({ inbox, mail, outbox }, { target: agent }))).toEqual({
      inbox: { connectionId: made.work, by: 'main', as: 'person' },
      mail: { connectionId: made.work, by: 'main', as: 'person' },
      outbox: { connectionId: made.work, by: 'main', as: 'person' },
    });
  });
});

describe("a tool's set of connections", () => {
  const agent: ConnectionTarget = { agentId: 'mail-helper' };
  const ana: PrincipalRef = { kind: 'user', id: 'user-ana', tenantId };
  const read: ConnectionNeed = { app: 'google', permissions: ['gmail.readonly'], as: 'company' };
  const personal: ConnectionNeed = { ...read, as: 'person' };
  /** Three ways the call's tool, at the version its agent resolves to now, may not take a set. */
  const moves: Partial<TargetTool>[] = [
    { effects: [{ kind: 'sensitive-data-egress' }] },
    { mutating: true },
    { input: { type: 'object', properties: { accounts: { type: 'array' } } } },
  ];

  /** The company's support, sales and desk, each named and reading; `acme.mail.send` reads one. */
  function sets() {
    const made = setup();
    const add = (label: string, owner: 'company' | 'ana' = 'company') =>
      made.seed.connection({
        tenantId,
        envName,
        app: 'google',
        owner: owner === 'ana' ? { kind: 'member', userId: ana.id } : { kind: 'company' },
        account: { id: `${label}@acme.example`, label: `${label}@acme.example` },
        label,
        permissions: ['gmail.readonly'],
      }).connectionId;
    const [support, sales, desk] = [add('support'), add('sales'), add('desk')];
    made.retool([tool({ inbox: read })]);
    /** The company's choice for the agent, or a tool's need's (`toolId`); with `by`, a person's. */
    const choose = async (
      connectionId: string,
      more: { toolId?: string; connectionIds?: string[]; by?: PrincipalRef } = {},
    ) => {
      const { by, ...rest } = more;
      const set = await made.binding.setChoice({
        tenantId,
        projectId,
        envName,
        ...agent,
        connectionId,
        ...(by !== undefined && { person: { userId: by.id } }),
        by: by ?? admin,
        ...rest,
      });
      if (set.kind !== 'ok') throw new Error(set.error.message);
      return set.value;
    };
    return { ...made, add, support, sales, desk, choose };
  }

  test("a call names a member of its tool's set, or reads its default; the record counts the set", async () => {
    const made = sets();
    const choice = await made.choose(made.sales, {
      toolId: 'acme.mail.send',
      connectionIds: [made.support, made.sales],
    });
    const call = async (accounts?: Record<string, string>) =>
      picked(
        await made.resolve(
          { inbox: read },
          { person: null, target: agent, ...(accounts !== undefined && { accounts }) },
        ),
      );
    const of = (connectionId: string, by: 'choice' | 'named') => ({
      inbox: { connectionId, by, choiceId: choice.choiceId, as: 'company', setSize: 2 },
    });
    expect(await call()).toEqual(of(made.sales, 'choice'));
    expect(await call({ inbox: made.support })).toEqual(of(made.support, 'named'));
    expect(await call({ inbox: made.sales })).toEqual(of(made.sales, 'named'));
    // A name for a need the call doesn't have changes nothing.
    expect(await call({ outbox: made.support })).toEqual(of(made.sales, 'choice'));
    // A name outside the set answers as no connection does, and never picks another.
    for (const outside of [made.desk, '00000000-0000-4000-8000-00000000dead']) {
      expect(await call({ inbox: outside })).toEqual({
        kind: 'refused',
        code: 'connection-missing',
        name: 'inbox',
        app: 'google',
        missing: ['gmail.readonly'],
        message: `"inbox" needs a Google connection, and there's none`,
      });
    }
    // The run's mailbox binds the need before any name.
    const mailbox: ConnectionRunMailbox = { app: 'google', as: 'company', connectionId: made.desk };
    const bound = await made.resolve(
      { inbox: read },
      { person: null, target: agent, mailbox, accounts: { inbox: made.support } },
    );
    expect(picked(bound)).toEqual({
      inbox: { connectionId: made.desk, by: 'mailbox', as: 'company' },
    });
  });

  test('a call that names a member, when its tool at the version it resolves to now may not take a set, is connection-missing and never reads the default', async () => {
    const made = sets();
    await made.choose(made.sales, {
      toolId: 'acme.mail.send',
      connectionIds: [made.support, made.sales],
    });
    // Every token handed out is renewed first, so the fake app's calls list each connection read.
    const named = () =>
      made.resolve(
        { inbox: read },
        { person: null, target: agent, accounts: { inbox: made.support }, renew: ['inbox'] },
      );
    // As a name outside the set answers: the name isn't repeated.
    const missing = {
      kind: 'refused',
      code: 'connection-missing',
      name: 'inbox',
      app: 'google',
      missing: ['gmail.readonly'],
      message: `"inbox" needs a Google connection, and there's none`,
    };
    for (const moved of moves) {
      made.retool([tool({ inbox: read }, moved)]);
      expect(await named()).toEqual(missing);
    }
    // And one its agent no longer has.
    made.retool([]);
    expect(await named()).toEqual(missing);
    expect(made.calls).toEqual([]);
    const sales = await made.binding.get({ tenantId, connectionId: made.sales });
    expect(sales).not.toHaveProperty('lastUsedAt');
  });

  test("a call with no agent or flow has no set: one that names a connection is connection-missing, even its need's only one", async () => {
    const made = setup();
    const only = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'company' },
      account: { id: 'support@acme.example', label: 'support@acme.example' },
      label: 'support',
      permissions: ['gmail.readonly'],
    }).connectionId;
    made.retool([tool({ inbox: read })]);
    const alone = (accounts?: Record<string, string>) =>
      made.resolve(
        { inbox: read },
        { person: null, renew: ['inbox'], ...(accounts !== undefined && { accounts }) },
      );
    // Naming none, the call reads the only one.
    expect(picked(await alone())).toEqual({
      inbox: { connectionId: only, by: 'only', as: 'company' },
    });
    const seen = made.calls.length;
    expect(seen).toBeGreaterThan(0);
    expect(await alone({ inbox: only })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'inbox',
      app: 'google',
      missing: ['gmail.readonly'],
      message: `"inbox" needs a Google connection, and there's none`,
    });
    expect(made.calls).toHaveLength(seen);
  });

  test('a call that names nothing reads the default, whatever version its tool resolves to now', async () => {
    const made = sets();
    const choice = await made.choose(made.sales, {
      toolId: 'acme.mail.send',
      connectionIds: [made.support, made.sales],
    });
    // Every token handed out is renewed first, so the fake app's calls list each connection read.
    const unnamed = async () =>
      picked(
        await made.resolve({ inbox: read }, { person: null, target: agent, renew: ['inbox'] }),
      );
    const byDefault = {
      inbox: {
        connectionId: made.sales,
        by: 'choice',
        choiceId: choice.choiceId,
        as: 'company',
        setSize: 2,
      },
    };
    for (const moved of [{}, ...moves]) {
      made.retool([tool({ inbox: read }, moved)]);
      expect(await unnamed()).toEqual(byDefault);
    }
    made.retool([]);
    expect(await unnamed()).toEqual(byDefault);
    // Each call read the default, and no other connection.
    expect(made.calls.map((c) => c.connectionId)).toEqual(
      Array.from({ length: moves.length + 2 }, () => made.sales),
    );
  });

  test("the tool's choice beats the agent's; another tool's call reads the agent's", async () => {
    const made = sets();
    const agentWide = await made.choose(made.desk);
    const forTool = await made.choose(made.support, { toolId: 'acme.mail.send' });
    const call = async (toolId?: string) =>
      picked(
        await made.resolve(
          { inbox: read },
          { person: null, target: agent, ...(toolId !== undefined && { toolId }) },
        ),
      );
    const byChoice = (connectionId: string, choiceId: string) => ({
      inbox: { connectionId, by: 'choice', choiceId, as: 'company' },
    });
    expect(await call()).toEqual(byChoice(made.support, forTool.choiceId));
    expect(await call('acme.mail.read')).toEqual(byChoice(made.desk, agentWide.choiceId));
  });

  test("a person's set: the call names one of theirs, and a refusal names none", async () => {
    const made = sets();
    made.retool([tool({ inbox: personal })]);
    const [work, school] = [made.add('Work', 'ana'), made.add('School', 'ana')];
    const choice = await made.choose(work, {
      toolId: 'acme.mail.send',
      connectionIds: [work, school],
      by: ana,
    });
    expect(choice).toMatchObject({ connectionIds: [work, school], person: { userId: ana.id } });
    const call = async (accounts: Record<string, string>) =>
      picked(await made.resolve({ inbox: personal }, { target: agent, accounts }));
    expect(await call({ inbox: school })).toEqual({
      inbox: {
        connectionId: school,
        by: 'named',
        choiceId: choice.choiceId,
        as: 'person',
        setSize: 2,
      },
    });
    expect(await call({ inbox: made.support })).toMatchObject({
      code: 'connection-missing',
      message: `"inbox" needs a Google connection, and there's none`,
    });
    await made.binding.disconnect({ tenantId, connectionId: school, by: ana });
    expect(await call({ inbox: school })).toEqual({
      kind: 'refused',
      code: 'connection-missing',
      name: 'inbox',
      app: 'google',
      message: `"inbox"'s Google connection was disconnected; choose another`,
    });
  });

  test("accountChoices: once per turn, each tool's needs whose choice is a set, its members still candidates, its default's id", async () => {
    const made = sets();
    const forward = 'acme.mail.forward' as ToolId;
    made.retool([tool({ inbox: read }), tool({ inbox: read }, { id: forward })]);
    await made.choose(made.sales, {
      toolId: 'acme.mail.send',
      connectionIds: [made.support, made.sales, made.desk],
    });
    await made.choose(made.support, { toolId: forward, connectionIds: [made.support, made.sales] });
    await made.binding.disconnect({ tenantId, connectionId: made.desk, by: admin });
    // forward's version now may send what it reads elsewhere.
    made.retool([
      tool({ inbox: read }),
      tool({ inbox: read }, { id: forward, effects: [{ kind: 'sensitive-data-egress' }] }),
    ]);
    const turn = (more: Partial<ConnectionAccountChoicesInput> = {}) =>
      made.resolver.accountChoices?.({
        tenantId,
        projectId,
        envName,
        runId: 'run-1',
        target: agent,
        tools: ['acme.mail.send', forward, 'acme.mail.gone'].map((toolId) => ({
          toolId,
          needs: { inbox: read },
        })),
        ...more,
      });
    expect(await turn()).toEqual({
      'acme.mail.send': {
        inbox: {
          appName: 'Google',
          members: [
            { name: 'support', connectionId: made.support },
            { name: 'sales', connectionId: made.sales },
          ],
          default: made.sales,
        },
      },
    });
    // The run's mailbox binds the need: there's no set to name from.
    const mailbox: ConnectionRunMailbox = { app: 'google', as: 'company', connectionId: made.desk };
    expect(await turn({ mailbox })).toEqual({});
    expect(await turn({ target: { agentId: 'other-agent' } })).toEqual({});
  });

  test("accountChoices: a person's need offers their own set, and none in a run with no person", async () => {
    const made = sets();
    made.retool([tool({ inbox: personal })]);
    const [work, school] = [made.add('Work', 'ana'), made.add('School', 'ana')];
    await made.choose(school, { toolId: 'acme.mail.send', connectionIds: [work, school], by: ana });
    const turn = (person?: string) =>
      made.resolver.accountChoices?.({
        tenantId,
        projectId,
        envName,
        runId: 'run-1',
        target: agent,
        ...(person !== undefined && { person: { userId: person } }),
        tools: [{ toolId: 'acme.mail.send', needs: { inbox: personal } }],
      });
    expect(await turn(ana.id)).toEqual({
      'acme.mail.send': {
        inbox: {
          appName: 'Google',
          members: [
            { name: 'Work', connectionId: work },
            { name: 'School', connectionId: school },
          ],
          default: school,
        },
      },
    });
    expect(await turn()).toEqual({});
    expect(await turn('user-ben')).toEqual({});
  });
});
