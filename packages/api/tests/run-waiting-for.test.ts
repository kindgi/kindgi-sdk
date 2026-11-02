// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs/{runId}`'s `waitingFor`: a suspended run says what it waits
 * for. An approval carries its identity and state, and for a tool call the
 * tool and the call by name; never the call's arguments, nor anything else
 * of the approval's subject, description, context or decision.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { google } from '@kindgi/connections/google';
import type { JournalEntry, RunBinding } from '@kindgi/runtime';
import type { EnvName, RunId, TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import type { ConnectRequestRecord, ConnectionBinding } from '../src/connection-binding.js';
import type { Approval, HitlBinding } from '../src/hitl-binding.js';
import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'run-waiting-for';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const RUN = randomUUID() as RunId;
const CHILD = randomUUID();
const at = '2026-10-09T12:00:00.000Z';

function runRecord(id: string, status: string) {
  return {
    runId: id,
    tenantId,
    projectId: randomUUID(),
    flowId: 'agent.turn',
    flowVersion: '1.0.0',
    status,
    dryRun: false,
    createdAt: at,
    updatedAt: at,
  };
}

const suspended = (tokenId: string, timeoutMs?: number): JournalEntry =>
  ({
    sequence: 1,
    kind: 'wait.suspended',
    payload: { tokenId, ...(timeoutMs !== undefined && { timeoutMs }) },
    timestamp: at,
  }) as unknown as JournalEntry;
const resumed = (tokenId: string): JournalEntry =>
  ({
    sequence: 2,
    kind: 'wait.resumed',
    payload: { tokenId },
    timestamp: at,
  }) as unknown as JournalEntry;

function approval(waitTokenId: string, overrides: Partial<Approval> = {}): Approval {
  return {
    id: randomUUID(),
    tenantId,
    subjectKind: 'tool-call:pending',
    subjectRef: {
      conversationId: randomUUID(),
      agentId: 'acme.desk',
      agentVersion: '1.0.0',
      toolId: 'acme.refund',
      toolVersion: '1.0.0',
      callId: 'call_1',
      argsHash: 'sha256:secret-hash',
      arguments: { card: 'card-4242', amount: 900 },
    },
    requiredRole: 'approver',
    status: 'pending',
    title: 'HITL review: refund',
    description: 'Tool call refund awaiting reviewer approval before dispatch.',
    context: { note: 'context-canary' },
    waitTokenId,
    createdAt: at,
    updatedAt: at,
    expiresAt: '2026-10-10T12:00:00.000Z',
    ...overrides,
  } as unknown as Approval;
}

function harness(options: {
  status?: string;
  journal?: readonly JournalEntry[] | 'unreadable';
  approvals?: readonly Approval[];
  hitl?: boolean;
  connects?: readonly ConnectRequestRecord[] | 'unreadable';
}) {
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) =>
      id === RUN
        ? runRecord(RUN, options.status ?? 'suspended')
        : id === (CHILD as RunId)
          ? runRecord(CHILD, 'running')
          : null,
    readJournal: async () =>
      options.journal === 'unreadable'
        ? { kind: 'err', error: { code: 'journal-error', message: 'x' } }
        : { kind: 'ok', value: options.journal ?? [] },
  } as unknown as RunBinding;
  const hitlBinding = {
    listApprovals: async () => ({ kind: 'ok', value: { approvals: options.approvals ?? [] } }),
  } as unknown as HitlBinding;
  const connections = {
    entries: () => [google],
    requestsForRun: async ({ runId }: { runId: string }) => {
      if (options.connects === 'unreadable') throw new Error('the store is down');
      return (options.connects ?? []).filter((r) => r.runId === runId);
    },
  } as unknown as ConnectionBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    ...(options.hitl !== false && { hitlBinding }),
    ...(options.connects !== undefined && {
      connections,
      envName: 'local' as EnvName,
    }),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  return async () => {
    const res = await app.request(`/v1/runs/${RUN}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
  };
}

describe("a suspended run's waitingFor", () => {
  test("a tool call held for review: the approval's identity and state, and the tool by name; never its arguments", async () => {
    const pending = approval('tok-1');
    const get = harness({ journal: [suspended('tok-1')], approvals: [pending] });
    const { status, text, body } = await get();
    expect(status).toBe(200);
    expect(body.waitingFor).toEqual({
      approvals: [
        {
          approvalId: pending.id,
          status: 'pending',
          requiredRole: 'approver',
          title: 'HITL review: refund',
          createdAt: at,
          expiresAt: '2026-10-10T12:00:00.000Z',
          subjectKind: 'tool-call:pending',
          tool: { id: 'acme.refund', version: '1.0.0', callId: 'call_1' },
        },
      ],
      other: [],
    });
    // Nothing else of the approval reaches a run reader.
    for (const hidden of [
      'arguments',
      'argsHash',
      'card-4242',
      'secret-hash',
      'description',
      'context-canary',
      'subjectRef',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  test('another kind of approval (a session gate): no tool', async () => {
    const gate = approval('tok-2', {
      subjectKind: 'session-gate:pending',
      subjectRef: {
        conversationId: randomUUID(),
        agentId: 'acme.desk',
        turnCount: 9,
        threshold: 8,
      },
    } as Partial<Approval>);
    const { body } = await harness({ journal: [suspended('tok-2')], approvals: [gate] })();
    expect(body.waitingFor.approvals).toHaveLength(1);
    expect(body.waitingFor.approvals[0]).not.toHaveProperty('tool');
    expect(body.waitingFor.approvals[0].subjectKind).toBe('session-gate:pending');
  });

  test('the other waits: a child run, a decided approval, a wait no approval is linked to', async () => {
    const done = approval('tok-3', { status: 'approved' } as Partial<Approval>);
    const { body } = await harness({
      journal: [suspended(`child:${CHILD}:4`, 60_000), suspended('tok-3'), suspended('tok-4')],
      approvals: [done],
    })();
    expect(body.waitingFor.approvals).toEqual([]);
    expect(body.waitingFor.other).toEqual([
      {
        what: 'child-run',
        childRunId: CHILD,
        childStatus: 'running',
        timesOutAt: '2026-10-09T12:01:00.000Z',
      },
      { what: 'decided-approval', approvalId: done.id, approvalStatus: 'approved' },
      { what: 'unattributed', tokenId: 'tok-4' },
    ]);
  });

  test('every wait resumed: no open wait', async () => {
    const { body } = await harness({ journal: [suspended('tok-5'), resumed('tok-5')] })();
    expect(body.waitingFor).toEqual({ approvals: [], other: [{ what: 'no-open-wait' }] });
  });

  test('without the approvals binding, the waits are unattributed', async () => {
    const { body } = await harness({
      journal: [suspended('tok-6')],
      approvals: [approval('tok-6')],
      hitl: false,
    })();
    expect(body.waitingFor).toEqual({
      approvals: [],
      other: [{ what: 'unattributed', tokenId: 'tok-6' }],
    });
  });
});

function connectRequest(
  waitToken: string,
  overrides: Partial<ConnectRequestRecord> = {},
): ConnectRequestRecord {
  return {
    requestId: randomUUID(),
    tenantId,
    envName: 'local' as EnvName,
    appId: randomUUID(),
    app: 'google',
    owner: { kind: 'member', userId: 'user-ana' },
    permissions: ['gmail.send'],
    says: ['Send mail as you'],
    runId: RUN,
    waitToken,
    name: 'mail',
    state: 'pending',
    connectUrl: 'https://kindgi.acme.example/console/connect/requests/r-1',
    expiresAt: '2026-10-09T13:00:00.000Z',
    createdAt: at,
    createdBy: 'system:resolver',
    ...overrides,
  };
}

describe("a suspended run's waitingFor: connects", () => {
  test('a tool waiting for a person to connect an app: what it asks for, in plain words, and where', async () => {
    const waiting = connectRequest('connect-1');
    const get = harness({
      journal: [suspended('connect-1')],
      connects: [
        waiting,
        // A request already connected, and one for a wait that isn't open: not listed.
        connectRequest('connect-0', { state: 'connected' }),
        connectRequest('connect-9'),
      ],
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.waitingFor).toEqual({
      approvals: [],
      other: [],
      connections: [
        {
          name: 'mail',
          requestId: waiting.requestId,
          waitToken: 'connect-1',
          app: 'google',
          appName: 'Google',
          says: ['Send mail as you'],
          connectUrl: 'https://kindgi.acme.example/console/connect/requests/r-1',
          expiresAt: '2026-10-09T13:00:00.000Z',
        },
      ],
    });
  });

  test('a reconnect says so', async () => {
    const get = harness({
      journal: [suspended('connect-1')],
      connects: [connectRequest('connect-1', { reconnects: randomUUID() })],
    });
    const { body } = await get();
    expect(body.waitingFor.connections[0].reconnects).toBe(true);
  });

  test("requests that can't be read leave the wait unattributed", async () => {
    const get = harness({ journal: [suspended('connect-1')], connects: 'unreadable' });
    const { body } = await get();
    expect(body.waitingFor).toEqual({
      approvals: [],
      other: [{ what: 'unattributed', tokenId: 'connect-1' }],
    });
  });

  test('an approval only one member decides says who, and the account the call would use', async () => {
    const pending = approval('tok-1', {
      approver: { kind: 'member', userId: 'user-ana' },
      connection: { app: 'google', appName: 'Google', account: 'ana@acme.example' },
    });
    const get = harness({ journal: [suspended('tok-1')], approvals: [pending] });
    const { body } = await get();
    expect(body.waitingFor.approvals[0]).toMatchObject({
      approver: { kind: 'member', userId: 'user-ana' },
      connection: { app: 'google', appName: 'Google', account: 'ana@acme.example' },
    });
  });

  test("a company connection's approval says which connection, named, and no one decides it alone", async () => {
    const connection = {
      app: 'google',
      appName: 'Google',
      account: 'support@acme.example',
      name: 'support',
    };
    const get = harness({
      journal: [suspended('tok-1')],
      approvals: [approval('tok-1', { connection })],
    });
    const { body } = await get();
    expect(body.waitingFor.approvals[0].connection).toEqual(connection);
    expect(body.waitingFor.approvals[0]).not.toHaveProperty('approver');
  });
});

describe('waitingFor is left out', () => {
  test('on a run that is not suspended', async () => {
    const { body } = await harness({ status: 'running', journal: [suspended('tok-7')] })();
    expect(body).not.toHaveProperty('waitingFor');
  });

  test("when the journal can't be read: the run still answers", async () => {
    const { status, body } = await harness({ journal: 'unreadable' })();
    expect(status).toBe(200);
    expect(body.status).toBe('suspended');
    expect(body).not.toHaveProperty('waitingFor');
  });
});
