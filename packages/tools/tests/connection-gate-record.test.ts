// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  CONNECTION_GATE_RECORD_PREFIX,
  type ConnectionChoiceOption,
  type ConnectionNeed,
  type ConnectionPick,
  type ResolveConnectionsOutcome,
  type ToolConnection,
  type WaitingForConnection,
  connectionGateRecordOf,
} from '../src/index.js';

const TOKEN = 'tok-secret-1234';

const mail: ConnectionNeed = { app: 'acme', permissions: ['mail.send'], as: 'person' };
const shared: ConnectionNeed = { app: 'acme', permissions: ['notes.read'], as: 'company' };
const registration = { id: 'reg-acme-1', name: 'Acme (reg-acme)' };

const connection = (connectionId: string, label: string, name?: string): ToolConnection => ({
  connectionId,
  app: 'acme',
  appName: 'Acme',
  accessToken: TOKEN,
  account: { id: `acct-${connectionId}`, label },
  ...(name !== undefined && { name }),
});

/** Every string a value holds as its own, all the way down. */
function stringsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null || depth > 10) return [];
  return Reflect.ownKeys(value).flatMap((key) => stringsOf(Reflect.get(value, key), depth + 1));
}

/** The record of `outcome`, which never holds the token. */
function recordOf(
  outcome: ResolveConnectionsOutcome,
  needs: Readonly<Record<string, ConnectionNeed>>,
) {
  const record = connectionGateRecordOf(outcome, needs);
  expect(stringsOf(record).join(' ')).not.toContain(TOKEN);
  return record;
}

describe("a call's connection gate record", () => {
  test("its key's prefix is the one older runs' records have", () => {
    expect(CONNECTION_GATE_RECORD_PREFIX).toBe('connection-gate:');
  });

  test("a company's connection: its account, its name and how it was picked, and nothing more", () => {
    const pick = {
      by: 'choice',
      choiceId: 'choice-1',
      as: 'company',
      setSize: 2,
      registration: { ...registration, extra: 'not recorded' },
      extra: 'not recorded',
    } as ConnectionPick;
    const support = {
      ...connection('conn-support', 'support@acme.example', 'support'),
      expiresAt: '2026-11-03T12:00:00Z',
      extra: 'not recorded',
    } as ToolConnection;
    const record = recordOf(
      { kind: 'ready', connections: { shared: support }, picks: { shared: pick } },
      { shared },
    );
    expect(record).toEqual({
      kind: 'ready',
      connections: {
        shared: {
          connectionId: 'conn-support',
          app: 'acme',
          appName: 'Acme',
          account: { id: 'acct-conn-support', label: 'support@acme.example' },
          name: 'support',
          pick: { by: 'choice', choiceId: 'choice-1', as: 'company', setSize: 2, registration },
        },
      },
    });
  });

  test("a person's connection: its account id alone, and no name, even when the resolver gives one", () => {
    const record = recordOf(
      {
        kind: 'ready',
        connections: { mail: connection('conn-mail', 'owner@acme.example', 'mine') },
      },
      { mail },
    );
    expect(record).toEqual({
      kind: 'ready',
      connections: {
        mail: {
          connectionId: 'conn-mail',
          app: 'acme',
          appName: 'Acme',
          account: { id: 'acct-conn-mail' },
        },
      },
    });
    expect(stringsOf(record).join(' ')).not.toContain('owner@acme.example');
  });

  test("a ready answer doesn't say the call's run is recorded: only a gate that records it does", () => {
    const record = recordOf(
      {
        kind: 'ready',
        connections: { mail: connection('conn-mail', 'owner@acme.example', 'mine') },
      },
      { mail },
    );
    expect(record.kind).toBe('ready');
    expect(record).not.toHaveProperty('recordsRan');
  });

  test("the company's connection-not-chosen: whose need it was, and its choices by id and name only", () => {
    const message =
      'This project has 2 company Acme connections (sales, support), and agent pack.agent has no choice of one.';
    const record = recordOf(
      {
        kind: 'refused',
        code: 'connection-not-chosen',
        name: 'shared',
        app: 'acme',
        choices: [
          {
            connectionId: 'conn-sales',
            name: 'sales',
            accessToken: TOKEN,
          } as ConnectionChoiceOption,
          { connectionId: 'conn-support', name: 'support' },
        ],
        message,
      },
      { mail, shared },
    );
    expect(record).toEqual({
      kind: 'refused',
      code: 'connection-not-chosen',
      name: 'shared',
      app: 'acme',
      as: 'company',
      choices: [
        { connectionId: 'conn-sales', name: 'sales' },
        { connectionId: 'conn-support', name: 'support' },
      ],
      message,
    });
  });

  test.each([
    ['connection-needs-a-person', {}],
    ['connection-not-chosen', {}],
    ['connection-missing', { missing: ['mail.send'] }],
  ] as const)("a person's %s: whose need it was, the run's person's", (code, more) => {
    const refused: ResolveConnectionsOutcome = {
      kind: 'refused',
      code,
      name: 'mail',
      app: 'acme',
      ...more,
      message: 'No.',
    };
    expect(recordOf(refused, { mail, shared })).toEqual({ ...refused, as: 'person' });
  });

  test("a refusal whose name isn't one of the needs: no `as`", () => {
    const refused = {
      kind: 'refused',
      code: 'connection-app-missing',
      name: 'other',
      app: 'acme',
      message: 'No.',
    } as const;
    expect(recordOf(refused, { mail })).toStrictEqual(refused);
  });

  test('a wait: each request by its own fields, and `reconnects` only when it says so', () => {
    const request: WaitingForConnection = {
      name: 'mail',
      requestId: 'req-1',
      waitToken: 'wait-1',
      app: 'acme',
      appName: 'Acme',
      says: ['Send mail as you'],
      connectUrl: 'https://acme.example/connect/req-1',
      expiresAt: '2026-11-03T12:00:00Z',
    };
    const again = { ...request, name: 'notes', requestId: 'req-2', reconnects: true };
    const record = recordOf(
      {
        kind: 'wait',
        requests: [{ ...request, accessToken: TOKEN } as WaitingForConnection, again],
      },
      { mail },
    );
    expect(record).toStrictEqual({ kind: 'wait', requests: [request, again] });
  });
});
