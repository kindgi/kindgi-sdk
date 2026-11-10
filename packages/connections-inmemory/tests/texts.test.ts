// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ConnectRequestCreateInput } from '@kindgi/api';
import type { PrincipalRef } from '@kindgi/authz';
import { google } from '@kindgi/connections/google';
import { texts } from '@kindgi/connections/texts';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import { type FakeApp, createInMemoryConnections } from '../src/index.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const envName = 'local' as EnvName;
const admin: PrincipalRef = { kind: 'user', id: 'user-admin', tenantId };
const API_KEY = { envName, name: 'ACME_TEXTS_KEY' };
const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
const NUMBER = '+15551234567';
const company = { kind: 'company' } as const;

function setup(app: FakeApp = {}) {
  const made = createInMemoryConnections({
    entries: [google, texts],
    publicUrl: 'https://kindgi.acme.example/',
    app,
  });
  const textsApp = made.seed.app({
    tenantId,
    app: 'texts',
    token: { provider: 'telnyx', apiKey: API_KEY, publicKey: PUBLIC_KEY },
    by: admin,
  });
  const connect = (more: Partial<ConnectRequestCreateInput> = {}) =>
    made.binding.createRequest({
      tenantId,
      envName,
      app: 'texts',
      owner: company,
      permissions: ['texts.reply'],
      number: NUMBER,
      by: admin,
      ...more,
    });
  return { ...made, textsApp, connect };
}

async function connected(
  made: ReturnType<typeof setup>,
  more?: Partial<ConnectRequestCreateInput>,
) {
  const outcome = await made.connect(more);
  if (outcome.kind !== 'ok') throw new Error(outcome.error.message);
  return outcome.value;
}

describe('a texts registration', () => {
  test('keeps the token body as given', () => {
    const { textsApp } = setup();
    expect(textsApp.token).toEqual({ provider: 'telnyx', apiKey: API_KEY, publicKey: PUBLIC_KEY });
    expect(textsApp.oauth2).toBeUndefined();
  });

  test.each([
    ['no token', {}, 'connection-app-invalid', 'token'],
    [
      'an oauth2 body',
      { oauth2: { clientId: 'acme', clientSecret: API_KEY } },
      'connection-app-invalid',
      'oauth2',
    ],
    [
      'a provider the server does not serve',
      { token: { provider: 'carrier-pigeon', apiKey: API_KEY, publicKey: PUBLIC_KEY } },
      'bad-input',
      'token.provider',
    ],
    [
      'a 31-byte public key',
      {
        token: {
          provider: 'telnyx',
          apiKey: API_KEY,
          publicKey: Buffer.alloc(31, 7).toString('base64'),
        },
      },
      'bad-input',
      'token.publicKey',
    ],
    [
      'a 33-byte public key',
      {
        token: {
          provider: 'telnyx',
          apiKey: API_KEY,
          publicKey: Buffer.alloc(33, 7).toString('base64'),
        },
      },
      'bad-input',
      'token.publicKey',
    ],
  ])('refuses %s', async (_name, body, code, field) => {
    const made = setup();
    const outcome = await made.binding.createApp({
      tenantId,
      app: 'texts',
      ...(body as object),
      by: admin,
    });
    expect(outcome).toMatchObject({ kind: 'err', error: { code, field } });
  });

  test("refuses a token body on another app's registration", async () => {
    const made = setup();
    const outcome = await made.binding.createApp({
      tenantId,
      app: 'google',
      token: { provider: 'telnyx', apiKey: API_KEY, publicKey: PUBLIC_KEY },
      by: admin,
    });
    expect(outcome).toMatchObject({
      kind: 'err',
      error: { code: 'connection-app-invalid', field: 'token' },
    });
  });

  test('takes a new public key and API key while it has connections', async () => {
    const made = setup();
    await connected(made);
    const key = Buffer.alloc(32, 9).toString('base64');
    const outcome = await made.binding.updateApp({
      tenantId,
      appId: made.textsApp.appId,
      token: { provider: 'telnyx', apiKey: { envName, name: 'ACME_TEXTS_KEY_2' }, publicKey: key },
      by: admin,
    });
    expect(outcome).toMatchObject({ kind: 'ok', value: { token: { publicKey: key } } });
  });
});

describe('connecting a number', () => {
  test('comes back connected at once, keeping its connect page and life', async () => {
    const made = setup();
    const request = await connected(made);
    expect(request.state).toBe('connected');
    expect(request.connectUrl).toBe(
      `https://kindgi.acme.example/console/connect/${request.requestId}`,
    );
    expect(Date.parse(request.expiresAt)).toBeGreaterThan(Date.parse(request.createdAt));
    const connection = await made.binding.get({
      tenantId,
      connectionId: request.connectionId as string,
    });
    expect(connection).toMatchObject({
      app: 'texts',
      appId: made.textsApp.appId,
      owner: company,
      account: { id: 'num-15551234567', label: NUMBER },
      label: NUMBER,
      permissions: ['texts.reply'],
      state: 'working',
    });
    expect(made.calls).toEqual([{ op: 'lookup', number: NUMBER, outcome: 'ok' }]);
  });

  test("keeps the request's label, else names it by the number", async () => {
    const made = setup();
    const request = await connected(made, { label: 'Front desk' });
    const connection = await made.binding.get({
      tenantId,
      connectionId: request.connectionId as string,
    });
    expect(connection?.label).toBe('Front desk');
  });

  test.each([
    ['no number', undefined],
    ['a number not in E.164', '555-1234'],
    ['a number with a leading zero', '+05551234567'],
  ])('refuses %s', async (_name, number) => {
    const made = setup();
    const outcome = await made.binding.createRequest({
      tenantId,
      envName,
      app: 'texts',
      owner: company,
      permissions: ['texts.reply'],
      by: admin,
      ...(number !== undefined && { number }),
    });
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'bad-input', field: 'number' } });
  });

  test.each([
    ['number', { number: NUMBER }],
    ['replaceInbound', { replaceInbound: true as const }],
  ])("refuses `%s` on another app's connect", async (field, more) => {
    const made = setup();
    made.seed.app({
      tenantId,
      app: 'google',
      oauth2: { clientId: 'acme', clientSecret: API_KEY },
      by: admin,
    });
    const outcome = await made.binding.createRequest({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: 'user-admin' },
      permissions: ['gmail.readonly'],
      by: admin,
      ...more,
    });
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'bad-input', field } });
  });

  test("refused by the provider is connection-app-refused, and nothing's stored", async () => {
    const made = setup({ lookUp: () => 'refused' });
    const outcome = await made.connect();
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'connection-app-refused' } });
    if (outcome.kind === 'err') expect(outcome.error.message).toContain('Telnyx');
    const listed = await made.binding.list({ tenantId, limit: 10 });
    expect(listed.data).toEqual([]);
    expect(made.calls).toEqual([{ op: 'lookup', number: NUMBER, outcome: 'refused' }]);
  });

  test("lands on the registration's connection of the number in the env", async () => {
    const made = setup();
    const first = await connected(made);
    const again = await connected(made, { permissions: ['texts.send'] });
    expect(again.connectionId).toBe(first.connectionId);
    const connection = await made.binding.get({
      tenantId,
      connectionId: first.connectionId as string,
    });
    expect(connection?.permissions).toEqual(['texts.reply', 'texts.send']);
  });
});

describe("a number's inbound elsewhere", () => {
  test.each([
    ['a webhook host', { host: 'hooks.acme.example' }],
    ['a messaging profile', { profile: 'Acme support' }],
  ])('is inbound-in-use when it goes to %s', async (_name, where) => {
    const made = setup();
    made.seed.inbound({ number: NUMBER, ...where });
    const outcome = await made.connect();
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'inbound-in-use', ...where } });
    if (outcome.kind === 'err') {
      expect(outcome.error.message).toContain("Kindgi's messaging profile");
      expect(outcome.error.message).toContain('outbound settings');
      const other = 'host' in where ? 'profile' : 'host';
      expect(outcome.error).not.toHaveProperty(other);
    }
    expect((await made.binding.list({ tenantId, limit: 10 })).data).toEqual([]);
  });

  test('replaceInbound goes ahead, and the removal puts the old inbound back', async () => {
    const restored: string[] = [];
    const made = setup({
      restoreInbound: ({ number }) => {
        restored.push(number);
        return 'ok';
      },
    });
    made.seed.inbound({ number: NUMBER, host: 'hooks.acme.example' });
    const request = await connected(made, { replaceInbound: true });
    expect(request.state).toBe('connected');
    const removed = await made.binding.disconnect({
      tenantId,
      connectionId: request.connectionId as string,
      by: admin,
    });
    expect(removed).toMatchObject({
      kind: 'ok',
      value: { state: 'removed', withdrawn: 'at-app', removedReason: 'disconnected' },
    });
    expect(restored).toEqual([NUMBER]);
    // Put back: a new connect finds it there again.
    expect(await made.connect()).toMatchObject({
      kind: 'err',
      error: { code: 'inbound-in-use', host: 'hooks.acme.example' },
    });
  });
});

describe('a number live in one place', () => {
  test('another env of the registration is number-in-use, naming it', async () => {
    const made = setup();
    await connected(made);
    const outcome = await made.connect({ envName: 'staging' as EnvName });
    expect(outcome).toMatchObject({
      kind: 'err',
      error: { code: 'number-in-use', appId: made.textsApp.appId, envName },
    });
  });

  test('another texts registration of the tenant is number-in-use, naming it', async () => {
    const made = createInMemoryConnections({
      entries: [texts],
      publicUrl: 'https://kindgi.acme.example/',
    });
    const token = { provider: 'telnyx' as const, apiKey: API_KEY, publicKey: PUBLIC_KEY };
    const one = made.seed.app({
      tenantId,
      app: 'texts',
      token,
      projects: ['p-one' as ProjectId],
      by: admin,
    });
    const two = made.seed.app({
      tenantId,
      app: 'texts',
      token,
      projects: ['p-two' as ProjectId],
      by: admin,
    });
    const ask = (appId: string) =>
      made.binding.createRequest({
        tenantId,
        envName,
        app: 'texts',
        appId,
        owner: company,
        permissions: ['texts.reply'],
        number: NUMBER,
        by: admin,
      });
    expect((await ask(one.appId)).kind).toBe('ok');
    expect(await ask(two.appId)).toMatchObject({
      kind: 'err',
      error: { code: 'number-in-use', appId: one.appId, envName },
    });
  });
});

describe('reconnecting a number', () => {
  test('makes a credential-refused connection work again', async () => {
    const made = setup();
    const request = await connected(made);
    const connectionId = request.connectionId as string;
    const marked = made.seed.credentialRefused({ tenantId, connectionId });
    expect(marked).toMatchObject({
      state: 'needs-reconnecting',
      stateReason: 'credential-refused',
    });
    const again = await connected(made, { reconnects: connectionId });
    expect(again).toMatchObject({ state: 'connected', connectionId, reconnects: connectionId });
    const connection = await made.binding.get({ tenantId, connectionId });
    expect(connection?.state).toBe('working');
    expect(connection).not.toHaveProperty('stateReason');
  });

  test("naming another number is connection-account-mismatch, naming the connection's", async () => {
    const made = setup();
    const request = await connected(made);
    const outcome = await made.connect({
      reconnects: request.connectionId as string,
      number: '+15559876543',
    });
    expect(outcome).toMatchObject({
      kind: 'err',
      error: { code: 'connection-account-mismatch' },
    });
    if (outcome.kind === 'err') expect(outcome.error.message).toContain(NUMBER);
  });

  test('only a texts connection can be marked credential-refused', () => {
    const made = setup();
    made.seed.app({
      tenantId,
      app: 'google',
      oauth2: { clientId: 'acme', clientSecret: API_KEY },
      by: admin,
    });
    const other = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: 'user-admin' },
      account: { id: 'g-1', label: 'admin@acme.example' },
      permissions: ['gmail.readonly'],
    });
    expect(() =>
      made.seed.credentialRefused({ tenantId, connectionId: other.connectionId }),
    ).toThrow(TypeError);
  });
});

describe('removing a number', () => {
  test('a failed restore leaves it removing; removing it again retries', async () => {
    let answer: 'ok' | 'failed' = 'failed';
    const made = setup({ restoreInbound: () => answer });
    made.seed.inbound({ number: NUMBER, profile: 'Acme support' });
    const request = await connected(made, { replaceInbound: true });
    const connectionId = request.connectionId as string;
    const failed = await made.binding.disconnect({ tenantId, connectionId, by: admin });
    expect(failed).toMatchObject({
      kind: 'err',
      error: { code: 'inbound-restore-failed', profile: 'Acme support' },
    });
    expect((await made.binding.get({ tenantId, connectionId }))?.state).toBe('removing');
    expect(await made.connect()).toMatchObject({
      kind: 'err',
      error: { code: 'connection-removing' },
    });
    answer = 'ok';
    expect(await made.binding.disconnect({ tenantId, connectionId, by: admin })).toMatchObject({
      kind: 'ok',
      value: { state: 'removed', withdrawn: 'at-app' },
    });
    expect(made.calls.filter((c) => c.op === 'restore-inbound')).toEqual([
      { op: 'restore-inbound', connectionId, outcome: 'failed' },
      { op: 'restore-inbound', connectionId, outcome: 'ok' },
    ]);
  });

  test('a failed restore with nothing kept names neither host nor profile', async () => {
    const made = setup({ restoreInbound: () => 'failed' });
    const request = await connected(made);
    const failed = await made.binding.disconnect({
      tenantId,
      connectionId: request.connectionId as string,
      by: admin,
    });
    expect(failed).toMatchObject({ kind: 'err', error: { code: 'inbound-restore-failed' } });
    if (failed.kind === 'err') {
      expect(failed.error).not.toHaveProperty('host');
      expect(failed.error).not.toHaveProperty('profile');
    }
  });

  test('skipInboundRestore drops the kept inbound unrestored', async () => {
    const made = setup({ restoreInbound: () => 'failed' });
    made.seed.inbound({ number: NUMBER, host: 'hooks.acme.example' });
    const request = await connected(made, { replaceInbound: true });
    const removed = await made.binding.disconnect({
      tenantId,
      connectionId: request.connectionId as string,
      skipInboundRestore: true,
      by: admin,
    });
    expect(removed).toMatchObject({ kind: 'ok', value: { state: 'removed' } });
    expect(made.calls.some((c) => c.op === 'restore-inbound')).toBe(false);
    // Nothing was put back: the next connect finds no inbound elsewhere.
    expect((await made.connect()).kind).toBe('ok');
  });

  test("skipInboundRestore is ignored for another app's connection", async () => {
    const made = setup();
    made.seed.app({
      tenantId,
      app: 'google',
      oauth2: { clientId: 'acme', clientSecret: API_KEY },
      by: admin,
    });
    const other = made.seed.connection({
      tenantId,
      envName,
      app: 'google',
      owner: { kind: 'member', userId: 'user-admin' },
      account: { id: 'g-1', label: 'admin@acme.example' },
      permissions: ['gmail.readonly'],
    });
    const removed = await made.binding.disconnect({
      tenantId,
      connectionId: other.connectionId,
      skipInboundRestore: true,
      by: admin,
    });
    expect(removed).toMatchObject({ kind: 'ok', value: { state: 'removed', withdrawn: 'at-app' } });
    expect(made.calls).toEqual([
      { op: 'withdraw', connectionId: other.connectionId, outcome: 'ok' },
    ]);
  });

  test('a registration removed with its numbers keeps them until each is put back', async () => {
    let answer: 'ok' | 'failed' = 'failed';
    const made = setup({ restoreInbound: () => answer });
    made.seed.inbound({ number: NUMBER, host: 'hooks.acme.example' });
    const request = await connected(made, { replaceInbound: true });
    const appId = made.textsApp.appId;
    const failed = await made.binding.removeApp({
      tenantId,
      appId,
      withConnections: true,
      by: admin,
    });
    expect(failed).toMatchObject({
      kind: 'err',
      error: { code: 'inbound-restore-failed', host: 'hooks.acme.example' },
    });
    expect((await made.binding.getApp({ tenantId, appId }))?.removedAt).toBeUndefined();
    const connectionId = request.connectionId as string;
    expect((await made.binding.get({ tenantId, connectionId }))?.state).toBe('removing');
    answer = 'ok';
    expect(
      await made.binding.removeApp({ tenantId, appId, withConnections: true, by: admin }),
    ).toMatchObject({ kind: 'ok', value: { connectionsRemoved: 1 } });
    expect(await made.binding.get({ tenantId, connectionId })).toMatchObject({
      state: 'removed',
      removedReason: 'registration-removed',
    });
  });
});
