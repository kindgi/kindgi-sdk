// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/corrections` and `/v1/corrector-groups`: correcting a finished run's
 * decisions, answer and items, sorting at save, supersede, list filters,
 * counts, changes, removal, and the corrector-group CRUD.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { makeInMemoryProjectBinding } from '@kindgi/platform';
import type { KernelRunRecord, RunAgentRef, RunBinding } from '@kindgi/runtime';
import {
  CORRECTION_ITEM,
  type ConversationId,
  type ProjectId,
  type RunId,
  type TenantId,
  type Timestamp,
  type UserId,
} from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  AgentVersionRecord,
  CorrectionRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { correctorGroupApplies, isReplayCopy, whyNotAssertable } from '../src/index.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';
import { itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID() as ProjectId;
const projectB = randomUUID() as ProjectId;
const USER_TOKEN = 'corrections-user-token';
const KEY_TOKEN = 'corrections-key-token';
const SENIOR_TOKEN = 'corrections-senior-token';

const resolveToken: TokenResolver = async (token) => {
  if (token === USER_TOKEN) return { tenantId, userId: 'user-1' as UserId };
  if (token === KEY_TOKEN) return { tenantId, tokenId: 'key-1' as never };
  if (token === SENIOR_TOKEN) {
    return { tenantId, userId: 'user-2' as UserId, reviewerRole: 'senior' };
  }
  return null;
};

const runHandler = {} as RunHandlerBinding;

const agentRef = (version: string): RunAgentRef => ({
  id: 'acme.matcher',
  version,
  conversationId: randomUUID() as ConversationId,
});

function row(overrides: Partial<KernelRunRecord> = {}): KernelRunRecord {
  const at = '2026-09-30T00:00:00.000Z' as Timestamp;
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId: projectA,
    flowId: 'acme.match',
    flowVersion: '1.0.0',
    status: 'completed',
    input: { query: 'acme' },
    output: { matches: [{ id: 'c1' }, { id: 'c2' }] },
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    agent: agentRef('2.0.0'),
    ...overrides,
  };
}

/** A stub agent registry whose resolved version advertises exactly these tool ids. */
const registryWithTools = (...ids: readonly string[]): AgentRegistryBinding =>
  ({
    getVersion: async () =>
      ({ tools: ids.map((id) => ({ id, version: '1.0.0' })) }) as unknown as AgentVersionRecord,
  }) as unknown as AgentRegistryBinding;

/** A stub agent registry that cannot resolve the corrected version (it is gone). */
const registryVersionGone = {
  getVersion: async () => null,
} as unknown as AgentRegistryBinding;

interface Harness {
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ) => Promise<{ readonly status: number; readonly body: Record<string, any> }>;
  /** A GET whose answer is read as it comes, not as JSON. */
  readonly get: (path: string, token?: string) => Promise<Response>;
  readonly binding: CorrectionRegistryBinding;
}

/** What a harness's stubbed conversation and run journal return, and how often they were read. */
interface TurnReads {
  readonly messages?: readonly unknown[];
  readonly journal?: readonly unknown[];
}

/**
 * With `grants`, the app checks authorization: it allows exactly the
 * `action type:id` pairs listed (`*`: every one), and records every check
 * in `checked`, and every refusal the API decides itself in `recorded`.
 */
interface Authz {
  readonly grants: readonly string[];
  readonly checked: string[];
  readonly recorded?: { action: Action; resource: string; decision: Decision }[];
}

function decision(authz: Authz, action: Action, resource: ResourceRef): Decision {
  const key = `${action} ${resource.type}:${resource.id}`;
  authz.checked.push(key);
  const allowed = authz.grants.includes('*') || authz.grants.includes(key);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

function harness(
  rows: KernelRunRecord[],
  reads: TurnReads = {},
  authz?: Authz,
  agentRegistry?: AgentRegistryBinding,
  /** Which projects serve each item, for one more than one project serves. */
  served?: ReturnType<typeof itemProjects>,
  /** Where exports are recorded. */
  auditEvents?: AuditEventBinding,
  /** The tenant's projects, with their settings. */
  projects?: ReturnType<typeof makeInMemoryProjectBinding>,
): Harness & { readonly reads: number[] } {
  const binding = inMemoryCorrections();
  const stubs = createStubAppBindings();
  // [readMessages calls, readJournal calls]
  const counts = [0, 0];
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) => rows.find((r) => r.runId === id) ?? null,
    readJournal: async () => {
      counts[1] = (counts[1] as number) + 1;
      return { kind: 'ok', value: reads.journal ?? [] };
    },
  } as unknown as RunBinding;
  const conversationBinding = {
    ...stubs.conversationBinding,
    readMessages: async () => {
      counts[0] = (counts[0] as number) + 1;
      return { kind: 'ok', value: reads.messages ?? [] };
    },
  } as unknown as typeof stubs.conversationBinding;
  const app = createApp({
    ...stubs,
    conversationBinding,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler,
    correctionRegistry: binding,
    ...(agentRegistry !== undefined && { agentRegistry }),
    ...(served !== undefined && { itemProjects: served }),
    ...(auditEvents !== undefined && { auditEvents }),
    ...(projects !== undefined && {
      projectBinding: projects.projects,
      projectMembershipBinding: projects.memberships,
    }),
    ...(authz !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_principal, action, resource) => decision(authz, action, resource),
          checkBatch: async (_principal, action, resources) =>
            resources.map((resource) => decision(authz, action, resource)),
          recordDecision: (_principal, action, resource, refusal) => {
            authz.recorded?.push({
              action,
              resource: `${resource.type}:${resource.id}`,
              decision: refusal,
            });
          },
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call: Harness['call'] = async (method, path, body, token = USER_TOKEN) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const get: Harness['get'] = async (path, token = USER_TOKEN) =>
    app.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { call, get, binding, reads: counts };
}

async function tenantClass(h: Harness, name = 'expert', weight = 3): Promise<string> {
  const res = await h.call('POST', '/v1/corrector-groups', {
    scope: { kind: 'tenant' },
    name,
    weight,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('POST /v1/corrections', () => {
  test('with a pointer: stores the item and the run copy', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);

    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c2', pointer: '/matches/1', rank: 1, verdict: 'right' }],
      why: 'Right company.',
      correctorGroupId: classId,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      runId: run.runId,
      projectId: projectA,
      subject: { kind: 'agent', id: 'acme.matcher', version: '2.0.0' },
      items: [{ key: 'c2', pointer: '/matches/1', rank: 1, verdict: 'right' }],
      why: 'Right company.',
      correctorGroupId: classId,
    });

    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.run).toMatchObject({
      runId: run.runId,
      input: { query: 'acme' },
      output: { matches: [{ id: 'c1' }, { id: 'c2' }] },
    });
  });

  test('stores what should have been called and echoes it back on read', async () => {
    const run = row();
    const h = harness([run]);
    const expected = {
      shouldCall: [{ tool: 'acme.refund', args: { amount: 25 } }],
      mustNotCall: ['acme.email'],
    };
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      ...expected,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ decisions: 'wrong', ...expected });
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body).toMatchObject({ decisions: 'wrong', ...expected });
  });

  test('a shouldCall entry without args answers args {}', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.refund' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.shouldCall).toEqual([{ tool: 'acme.refund', args: {} }]);
  });

  test('a tool in both shouldCall and mustNotCall is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.refund', args: {} }],
      mustNotCall: ['acme.refund'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain("can't be in both");
  });

  test('decisions wrong with neither a call nor a must-not-call is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [],
      mustNotCall: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain('at least one entry in shouldCall or mustNotCall');
  });

  test('shouldCall and mustNotCall without decisions wrong are a 400', async () => {
    const run = row();
    const h = harness([run]);
    for (const body of [
      { decisions: 'right', shouldCall: [{ tool: 'acme.refund' }] },
      { answer: 'wrong', why: 'No.', mustNotCall: ['acme.refund'] },
    ]) {
      const res = await h.call('POST', '/v1/corrections', { runId: run.runId, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('shouldCall and mustNotCall go with decisions: "wrong".');
    }
  });

  test('a body without runId is a 400', async () => {
    const res = await harness([]).call('POST', '/v1/corrections', { answer: 'right' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('runId is required.');
  });

  test('a body that says none of decisions, answer and items is a 400', async () => {
    const run = row();
    const h = harness([run]);
    for (const body of [{}, { why: 'No.' }, { items: [] }]) {
      const res = await h.call('POST', '/v1/corrections', { runId: run.runId, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('at least one of decisions, answer and items');
    }
  });

  test('items alone are a correction', async () => {
    const run = row();
    const res = await harness([run]).call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', pointer: '/matches/0', verdict: 'wrong' }],
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('decisions');
    expect(res.body).not.toHaveProperty('answer');
  });

  test('shouldSay without answer wrong is a 400', async () => {
    const run = row();
    const res = await harness([run]).call('POST', '/v1/corrections', {
      runId: run.runId,
      answer: 'right',
      shouldSay: 'Acme Corp.',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('shouldSay goes with answer: "wrong".');
  });

  test('answer wrong needs shouldSay or why', async () => {
    const run = row();
    const h = harness([run]);
    const bare = await h.call('POST', '/v1/corrections', { runId: run.runId, answer: 'wrong' });
    expect(bare.status).toBe(400);
    expect(bare.body.error.message).toBe('answer: "wrong" needs shouldSay or why.');
    for (const text of [{ shouldSay: 'Acme Corp.' }, { why: 'It named the wrong company.' }]) {
      const res = await h.call('POST', '/v1/corrections', {
        runId: run.runId,
        answer: 'wrong',
        ...text,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject(text);
    }
  });

  test('shouldSay or why over 4000 characters is a 400', async () => {
    const run = row();
    const h = harness([run]);
    for (const name of ['shouldSay', 'why']) {
      const res = await h.call('POST', '/v1/corrections', {
        runId: run.runId,
        answer: 'wrong',
        [name]: 'x'.repeat(4001),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(`${name} must be a string of at most 4000 characters.`);
    }
  });

  test('more than 100 items is a 400', async () => {
    const run = row();
    const items = Array.from({ length: 101 }, (_, i) => ({ key: `c${i}`, verdict: 'right' }));
    const res = await harness([run]).call('POST', '/v1/corrections', { runId: run.runId, items });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('items holds at most 100 entries.');
  });

  test("an item's key over 200 characters, or its pointer over 500, is a 400", async () => {
    const run = row();
    // A pointer at the cap still has to point at something in the output.
    const deep = row({ output: { ['p'.repeat(499)]: 'x' } });
    const h = harness([run, deep]);
    const long = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'k'.repeat(201), verdict: 'wrong' }],
    });
    expect(long.status).toBe(400);
    expect(long.body.error.message).toBe(
      "an item's key is at most 200 characters: its id, not its text.",
    );
    const far = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', pointer: `/${'p'.repeat(500)}`, verdict: 'wrong' }],
    });
    expect(far.status).toBe(400);
    expect(far.body.error.message).toBe("an item's pointer is at most 500 characters.");
    const fits = await h.call('POST', '/v1/corrections', {
      runId: deep.runId,
      items: [{ key: 'k'.repeat(200), pointer: `/${'p'.repeat(499)}`, verdict: 'wrong' }],
    });
    expect(fits.status).toBe(201);
  });

  test('an item key twice is a 400', async () => {
    const run = row();
    const res = await harness([run]).call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [
        { key: 'c1', verdict: 'right' },
        { key: 'c1', verdict: 'wrong' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('the item key "c1" is in items twice.');
  });

  test('an item on the reserved key is a 400', async () => {
    const run = row();
    const res = await harness([run]).call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: CORRECTION_ITEM.key, verdict: 'wrong' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(`the item key "${CORRECTION_ITEM.key}" is reserved.`);
  });

  test.each<[string, unknown, string]>([
    ['item', { key: 'c1' }, 'answer and items'],
    ['verdict', 'yes', 'decisions and answer'],
    ['reason', 'Right company.', 'why'],
    ['correction', { calls: [], notCalled: ['acme.refund'] }, 'shouldCall and mustNotCall'],
  ])('the old field %s is a 400 naming the new ones', async (old, value, now) => {
    const run = row();
    const res = await harness([run]).call('POST', '/v1/corrections', {
      runId: run.runId,
      answer: 'right',
      [old]: value,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(`${old} is gone: a correction says ${now}.`);
  });

  test('a shouldCall entry with oversized args is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.refund', args: { note: 'x'.repeat(4100) } }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('4000');
  });

  test('a shouldCall entry with an over-long tool name is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: `acme.${'z'.repeat(220)}`, args: {} }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('200');
  });

  test('a mustNotCall tool name that is too long is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      mustNotCall: [`acme.${'z'.repeat(220)}`],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('200');
  });

  test('a second correction by the same caller on the same run replaces the first (counts once)', async () => {
    const run = row();
    const h = harness([run]);
    const post = (amount: number) =>
      h.call('POST', '/v1/corrections', {
        runId: run.runId,
        decisions: 'wrong',
        shouldCall: [{ tool: 'acme.refund', args: { amount } }],
      });
    const first = await post(25);
    const second = await post(40);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // The first is superseded by the second, so the correction counts once.
    const gotFirst = await h.call('GET', `/v1/corrections/${first.body.id}`);
    expect(gotFirst.body.supersededBy).toBe(second.body.id);
    const list = await h.call('GET', `/v1/corrections?runId=${run.runId}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(second.body.id);
    expect(list.body.data[0].shouldCall).toEqual([{ tool: 'acme.refund', args: { amount: 40 } }]);
    expect(list.body.data[0]).not.toHaveProperty('mustNotCall');
  });

  test('a correction may name tools the corrected version has', async () => {
    const run = row();
    const h = harness([run], {}, undefined, registryWithTools('acme.refund', 'acme.email'));
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.refund', args: { amount: 25 } }],
      mustNotCall: ['acme.email'],
    });
    expect(res.status).toBe(201);
  });

  test('a correction naming a call tool the version lacks is a 400', async () => {
    const run = row();
    const h = harness([run], {}, undefined, registryWithTools('acme.refund'));
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.ghost', args: {} }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain('acme.ghost');
  });

  test('a correction naming a must-not-call tool the version lacks is a 400', async () => {
    const run = row();
    const h = harness([run], {}, undefined, registryWithTools('acme.refund'));
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      mustNotCall: ['acme.ghost'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('acme.ghost');
  });

  test('an unknown tool is allowed when the corrected version cannot be resolved', async () => {
    const run = row();
    const h = harness([run], {}, undefined, registryVersionGone);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.ghost', args: {} }],
    });
    expect(res.status).toBe(201);
  });

  test('a flow subject skips the tool check (best-effort)', async () => {
    const { agent: _agent, ...flowRun } = row();
    const h = harness([flowRun], {}, undefined, registryWithTools('acme.refund'));
    const res = await h.call('POST', '/v1/corrections', {
      runId: flowRun.runId,
      decisions: 'wrong',
      shouldCall: [{ tool: 'acme.ghost', args: {} }],
    });
    expect(res.status).toBe(201);
  });

  test('the run copy keeps the segment path the run was started with (none: empty)', async () => {
    const acme = row({ segments: [{ key: 'company', value: 'acme' }] });
    const plain = row();
    const h = harness([acme, plain]);
    for (const run of [acme, plain]) {
      const res = await h.call('POST', '/v1/corrections', {
        runId: run.runId,
        items: [{ key: 'c1', verdict: 'wrong' }],
      });
      expect(res.status).toBe(201);
      const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
      expect(got.body.run.segments).toEqual(run.segments ?? []);
    }
  });

  test('a run that has not finished: 409 run-not-finished', async () => {
    const run = row({ status: 'running', output: undefined });
    const h = harness([run]);
    const classId = await tenantClass(h);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'wrong' }],
      correctorGroupId: classId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('run-not-finished');
  });

  test('a run an erasure cleared: 410 run-erased, never run-not-finished (T273 M-5)', async () => {
    const run = row({
      status: 'completed',
      output: null,
      contentErasedAt: '2026-10-08T00:00:00.000Z',
    } as never);
    const h = harness([run]);
    const classId = await tenantClass(h);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'wrong' }],
      correctorGroupId: classId,
    });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('run-erased');
  });

  test('an unknown run: 404 run-not-found', async () => {
    const h = harness([]);
    const classId = await tenantClass(h);
    const res = await h.call('POST', '/v1/corrections', {
      runId: randomUUID(),
      items: [{ key: 'c1', verdict: 'wrong' }],
      correctorGroupId: classId,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('run-not-found');
  });

  test('a pointer to nothing: 400 item-not-found', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c9', pointer: '/matches/9', verdict: 'right' }],
      correctorGroupId: classId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('item-not-found');
  });

  test("a project group on another project's run: 400 corrector-group-not-applicable", async () => {
    const run = row({ projectId: projectA });
    const h = harness([run]);
    const created = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'project', projectId: projectB },
      name: 'expert',
      weight: 1,
    });
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
      correctorGroupId: created.body.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('corrector-group-not-applicable');
  });

  test('a malformed body: 400 bad-input', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    for (const body of [
      { runId: run.runId, decisions: 'maybe', correctorGroupId: classId },
      { runId: run.runId, items: [{ key: 'c1', verdict: 'maybe' }], correctorGroupId: classId },
      { runId: run.runId, items: [{ verdict: 'right' }], correctorGroupId: classId },
      {
        runId: run.runId,
        items: [{ key: 'c1', pointer: 'matches', verdict: 'right' }],
        correctorGroupId: classId,
      },
    ]) {
      const res = await h.call('POST', '/v1/corrections', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad-input');
    }
  });

  test('correcting again supersedes: one live correction, the old one kept as history', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const body = { runId: run.runId, correctorGroupId: classId };
    const first = await h.call('POST', '/v1/corrections', { ...body, answer: 'right' });
    const second = await h.call('POST', '/v1/corrections', {
      ...body,
      answer: 'wrong',
      why: 'It named the wrong company.',
    });
    expect(second.status).toBe(201);

    const live = await h.call('GET', `/v1/corrections?runId=${run.runId}`);
    expect(live.body.data.map((j: { id: string }) => j.id)).toEqual([second.body.id]);

    const old = await h.call('GET', `/v1/corrections/${first.body.id}`);
    expect(old.body.supersededBy).toBe(second.body.id);
    expect(old.body.unregisteredAt).toBeTypeOf('string');
  });

  test('without a corrector group: recorded unclassified, no correctorGroupId on the wire', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('correctorGroupId');
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body).not.toHaveProperty('correctorGroupId');
  });

  test('a corrector group that does not exist: 400 corrector-group-not-applicable', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
      correctorGroupId: 'jc-missing',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('corrector-group-not-applicable');
  });

  test('a different participant does not supersede', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const body = {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
      correctorGroupId: classId,
    };
    await h.call('POST', '/v1/corrections', { ...body, participantId: 'end-user-1' });
    await h.call('POST', '/v1/corrections', { ...body, participantId: 'end-user-2' });
    const live = await h.call('GET', `/v1/corrections?runId=${run.runId}`);
    expect(live.body.data).toHaveLength(2);
  });

  test('madeBy comes from the principal, never the body', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const body = {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
      correctorGroupId: classId,
      madeBy: { kind: 'user', id: 'someone-else' },
    };
    const asUser = await h.call('POST', '/v1/corrections', body, USER_TOKEN);
    expect(asUser.body.madeBy).toEqual({ kind: 'user', id: 'user-1' });
    const asKey = await h.call('POST', '/v1/corrections', body, KEY_TOKEN);
    expect(asKey.body.madeBy).toEqual({ kind: 'service', id: 'key-1' });
  });
});

describe('correcting and authorization', () => {
  test("correcting a run needs write on the run's project, as cancelling one does", async () => {
    const run = row();
    const project = run.projectId as unknown as string;
    const granted: Authz = { grants: [`write project:${project}`], checked: [] };
    const allowed = await harness([run], {}, granted).call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    expect(allowed.status).toBe(201);
    expect(granted.checked).toContain(`write project:${project}`);

    const denied = await harness(
      [run],
      {},
      { grants: [`read project:${project}`], checked: [] },
    ).call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('permission-denied');
  });
});

describe("the context captured on a turn's first correction", () => {
  const messages = [
    { sequence: 0, role: 'user', content: 'hi' },
    { sequence: 1, role: 'assistant', content: 'hello' },
    { sequence: 2, role: 'user', content: 'find acme' },
    { sequence: 3, role: 'assistant', content: 'found it' },
  ];
  const journal = [
    { kind: 'step.started', nodeId: 'run-retrievals', payload: {} },
    {
      kind: 'step.completed',
      nodeId: 'run-retrievals',
      payload: { output: { retrieved: [{ source: 'kb', text: 'Acme Corp' }] } },
    },
  ];
  const turn = () =>
    row({
      output: {
        matches: [{ id: 'c1' }, { id: 'c2' }],
        appended: [
          { sequence: 2, role: 'user' },
          { sequence: 3, role: 'assistant' },
        ],
      },
    });

  test('history before the turn and what was retrieved are stored with the run copy', async () => {
    const run = turn();
    const h = harness([run], { messages, journal });
    const first = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    expect(first.status).toBe(201);
    const got = await h.call('GET', `/v1/corrections/${first.body.id}`);
    expect(got.body.run.context).toEqual({
      history: [messages[0], messages[1]],
      retrieved: [{ source: 'kb', text: 'Acme Corp' }],
    });
  });

  test('what the turn recalled of earlier conversations is kept too', async () => {
    const run = turn();
    const recalled = [
      {
        message: { conversationId: 'c-old', sequence: 4, role: 'user', text: 'Order 12 broke' },
        intent: { source: 'conversations', scope: 'same-user' },
      },
    ];
    const h = harness([run], {
      messages,
      journal: [
        journal[0],
        {
          kind: 'step.completed',
          nodeId: 'run-retrievals',
          payload: { output: { retrieved: [], recalled } },
        },
      ],
    });
    const first = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    expect(first.status).toBe(201);
    const got = await h.call('GET', `/v1/corrections/${first.body.id}`);
    expect(got.body.run.context).toMatchObject({ retrieved: [], recalled });
  });

  test("the decision at the turn's session approval gate is kept", async () => {
    const gated = (value: unknown) => [
      ...journal,
      {
        kind: 'value.recorded',
        nodeId: 'setup',
        payload: { scope: 's', key: 'session-hitl-gate', value: { waitTokenId: 'tok-1' } },
      },
      { kind: 'wait.suspended', nodeId: 'setup', payload: { tokenId: 'tok-1' } },
      { kind: 'wait.resumed', nodeId: 'setup', payload: { tokenId: 'tok-1', value } },
    ];
    const contextOf = async (value: unknown) => {
      const run = turn();
      const h = harness([run], { messages, journal: gated(value) });
      const res = await h.call('POST', '/v1/corrections', {
        runId: run.runId,
        items: [{ key: 'c1', verdict: 'right' }],
      });
      return (await h.call('GET', `/v1/corrections/${res.body.id}`)).body.run.context;
    };
    expect((await contextOf({ decided: 'approve', rationale: 'fine' })).sessionApproval).toEqual({
      approved: true,
    });
    expect((await contextOf({ decided: 'reject', rationale: 'not now' })).sessionApproval).toEqual({
      approved: false,
      rationale: 'not now',
    });
  });

  test('the env values its tools were sent are kept, by tool id (and only env-shaped records)', async () => {
    const run = row({
      output: {
        matches: [{ id: 'c1' }],
        appended: [
          { sequence: 2, role: 'user' },
          {
            sequence: 3,
            role: 'tool',
            content: { found: 1 },
            toolCall: { toolId: 'acme.lookup', invocationId: 'call-1' },
          },
          {
            sequence: 4,
            role: 'tool',
            content: { found: 2 },
            toolCall: { toolId: 'acme.score', invocationId: 'call-2' },
          },
        ],
      },
    });
    const recorded = (key: string, value: unknown) => ({
      kind: 'value.recorded',
      nodeId: 'dispatch-tools',
      payload: { scope: 'loop/dispatch-tools', key, value },
    });
    const h = harness([run], {
      messages,
      journal: [
        ...journal,
        recorded('tool-call:call-1:acme.lookup:env', { ORDERS_REGION: 'us' }),
        // Not env values: the record's value isn't strings only.
        recorded('tool-call:call-2:acme.score:env', { WEIGHT: 3 }),
        // Another tool's key form, or another call: not this turn's.
        recorded('tool-call:call-9:acme.lookup:env', { ORDERS_REGION: 'eu' }),
      ],
    });
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body.run.context.toolEnv).toEqual({ 'acme.lookup': { ORDERS_REGION: 'us' } });
  });

  test('a turn that never waited at the gate has no decision kept', async () => {
    const run = turn();
    const h = harness([run], { messages, journal });
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body.run.context).not.toHaveProperty('sessionApproval');
  });

  test('a second correction of the run does not read it again', async () => {
    const run = turn();
    const h = harness([run], { messages, journal });
    await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    expect(h.reads).toEqual([1, 1]);
    const second = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c2', verdict: 'wrong' }],
    });
    expect(second.status).toBe(201);
    expect(h.reads).toEqual([1, 1]);
  });

  test("a comparison's replay is stamped with the run it replays, at its first correction; any other run isn't", async () => {
    const replayedTurn = row({ runId: 'run-replay-turn' as RunId, replayOf: 'run-1' as RunId });
    const { agent: _agent, ...flowRun } = row({
      runId: 'run-replay-flow' as RunId,
      replayOf: 'run-2' as RunId,
    });
    const plain = row({ runId: 'run-plain' as RunId });
    const h = harness([replayedTurn, flowRun, plain], { messages, journal });
    const contextOf = async (runId: string) => {
      const res = await h.call('POST', '/v1/corrections', {
        runId,
        items: [{ key: 'c1', verdict: 'right' }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return (await h.call('GET', `/v1/corrections/${res.body.id}`)).body.run.context;
    };
    expect((await contextOf('run-replay-turn')).replayOf).toBe('run-1');
    // A flow replay with no tool calls keeps no other context, and is stamped all the same.
    expect(await contextOf('run-replay-flow')).toEqual({ replayOf: 'run-2' });
    expect(await contextOf('run-plain')).not.toHaveProperty('replayOf');
  });

  test('a flow run reads no conversation; with no tool calls to keep, it keeps no context', async () => {
    const { agent: _agent, ...run } = row();
    const h = harness([run], { messages, journal });
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
    });
    expect(res.status).toBe(201);
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body.run.context).toBeUndefined();
    // Its journal was read (for tool calls), its conversation never.
    expect(h.reads[0]).toBe(0);
  });
});

describe('GET /v1/corrections', () => {
  test('filters by run, agent and version, flow, group and status', async () => {
    const r1 = row();
    const r2 = row({ agent: agentRef('3.0.0') });
    const { agent: _agent, ...flowRun } = row({ flowId: 'acme.other' });
    const r3: KernelRunRecord = flowRun;
    const h = harness([r1, r2, r3]);
    const classId = await tenantClass(h);
    // A right item is fixed at save; a wrong one is open for Improve.
    const correct = (
      run: KernelRunRecord,
      key: string,
      verdict: 'right' | 'wrong',
      token = USER_TOKEN,
    ) =>
      h.call(
        'POST',
        '/v1/corrections',
        { runId: run.runId, items: [{ key, verdict }], correctorGroupId: classId },
        token,
      );
    await correct(r1, 'a', 'right');
    // Another author on the same run, so it doesn't supersede the first.
    await correct(r1, 'b', 'wrong', KEY_TOKEN);
    await correct(r2, 'a', 'right');
    await correct(r3, 'a', 'wrong');

    const list = async (qs: string) =>
      (await h.call('GET', `/v1/corrections?${qs}`)).body.data as {
        runId: string;
        status: string;
      }[];

    expect(await list(`runId=${r1.runId}`)).toHaveLength(2);
    expect(await list('agentId=acme.matcher')).toHaveLength(3);
    const v3 = await list('agentId=acme.matcher&agentVersion=3.0.0');
    expect(v3.map((j) => j.runId)).toEqual([r2.runId]);
    expect((await list('status=open')).map((j) => j.runId)).toEqual([r3.runId, r1.runId]);
    expect(await list('status=fixed')).toHaveLength(2);
    expect(await list('flowId=acme.other')).toHaveLength(1);
    expect(await list(`correctorGroupId=${classId}`)).toHaveLength(4);
  });

  test('agentVersion without agentId, or a verdict filter: 400', async () => {
    const h = harness([]);
    const a = await h.call('GET', '/v1/corrections?agentVersion=1.0.0');
    expect(a.status).toBe(400);
    const b = await h.call('GET', '/v1/corrections?verdict=no');
    expect([b.status, b.body.error.code, b.body.error.message]).toEqual([
      400,
      'bad-input',
      'verdict is gone: filter by status, sortedTo or from.',
    ]);
  });

  test('pages with limit and nextCursor fields on the wire shape', async () => {
    const runs = [row(), row(), row()];
    const h = harness(runs);
    const classId = await tenantClass(h);
    for (const run of runs) {
      await h.call('POST', '/v1/corrections', {
        runId: run.runId,
        items: [{ key: 'c1', verdict: 'right' }],
        correctorGroupId: classId,
      });
    }
    const page = await h.call('GET', '/v1/corrections?limit=2');
    expect(page.body.data).toHaveLength(2);
    expect(page.body.hasMore).toBe(true);
  });
});

describe('POST /v1/corrections/:id/remove', () => {
  test('removes the correction; it stops listing and a second removal is 404', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const made = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      items: [{ key: 'c1', verdict: 'right' }],
      correctorGroupId: classId,
    });
    const gone = await h.call('POST', `/v1/corrections/${made.body.id}/remove`, {});
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ correctionId: made.body.id, unregistered: true });

    expect((await h.call('GET', '/v1/corrections')).body.data).toHaveLength(0);
    const again = await h.call('POST', `/v1/corrections/${made.body.id}/remove`, {});
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('correction-not-found');
  });

  test('an unknown correction: 404 on get and unregister', async () => {
    const h = harness([]);
    expect((await h.call('GET', '/v1/corrections/nope')).status).toBe(404);
    expect((await h.call('POST', '/v1/corrections/nope/remove', {})).status).toBe(404);
  });
});

describe('/v1/corrector-groups', () => {
  test("whom a group names is for its scope's admins; every reader gets the count", async () => {
    const grants = [`admin project:${projectA}`, `read project:${projectA}`];
    const h = harness([], {}, { grants, checked: [] });
    const created = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'project', projectId: projectA },
      name: 'expert',
      weight: 3,
      assertableBy: { minReviewerRole: 'senior', principalIds: ['user-ada', 'user-bo'] },
    });
    expect([created.status, created.body.assertableBy]).toEqual([
      201,
      { minReviewerRole: 'senior', principalIds: ['user-ada', 'user-bo'], principalCount: 2 },
    ]);
    const id = created.body.id as string;
    const asAdmin = await h.call('GET', `/v1/corrector-groups/${id}`);
    expect(asAdmin.body.assertableBy.principalIds).toEqual(['user-ada', 'user-bo']);

    // A viewer of the project reads the group, but not whom it names.
    grants.splice(0, 1);
    const asViewer = { minReviewerRole: 'senior', principalCount: 2 };
    expect((await h.call('GET', `/v1/corrector-groups/${id}`)).body.assertableBy).toEqual(asViewer);
    const listed = await h.call('GET', '/v1/corrector-groups');
    expect(listed.body.data.map((k: Record<string, unknown>) => k.assertableBy)).toEqual([
      asViewer,
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('user-ada');
  });

  test('create, get, list, update, unregister', async () => {
    const h = harness([]);
    const created = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 3,
      description: 'Domain experts.',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      tenantId,
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 3,
      description: 'Domain experts.',
    });
    const id = created.body.id as string;

    expect((await h.call('GET', `/v1/corrector-groups/${id}`)).body.name).toBe('expert');
    expect((await h.call('GET', '/v1/corrector-groups')).body.data).toHaveLength(1);

    const patched = await h.call('PATCH', `/v1/corrector-groups/${id}`, { weight: 5 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ weight: 5, description: 'Domain experts.' });

    const gone = await h.call('POST', `/v1/corrector-groups/${id}/unregister`, {});
    expect(gone.body).toEqual({ correctorGroupId: id, unregistered: true });
    expect((await h.call('GET', '/v1/corrector-groups')).body.data).toHaveLength(0);
    // A retired group stays readable, but cannot be changed or retired again.
    const retired = await h.call('GET', `/v1/corrector-groups/${id}`);
    expect(retired.status).toBe(200);
    expect(retired.body.unregisteredAt).toBeTypeOf('string');
    expect((await h.call('PATCH', `/v1/corrector-groups/${id}`, { weight: 1 })).status).toBe(404);
    expect((await h.call('POST', `/v1/corrector-groups/${id}/unregister`, {})).status).toBe(404);
  });

  test('the same name twice in one scope: 409 corrector-group-name-taken', async () => {
    const h = harness([]);
    await tenantClass(h, 'expert');
    const dup = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 1,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('corrector-group-name-taken');
    // The same name in another scope is fine.
    const other = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'project', projectId: projectA },
      name: 'expert',
      weight: 1,
    });
    expect(other.status).toBe(201);
  });

  test('list narrows by scope; an incomplete scope is 400', async () => {
    const h = harness([]);
    await tenantClass(h, 'expert');
    await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'agent', projectId: projectA, agentId: 'acme.matcher' },
      name: 'user',
      weight: 1,
    });
    const tenantOnly = await h.call('GET', '/v1/corrector-groups?scopeKind=tenant');
    expect(tenantOnly.body.data.map((k: { name: string }) => k.name)).toEqual(['expert']);
    const agent = await h.call(
      'GET',
      `/v1/corrector-groups?scopeKind=agent&projectId=${projectA}&agentId=acme.matcher`,
    );
    expect(agent.body.data.map((k: { name: string }) => k.name)).toEqual(['user']);
    expect((await h.call('GET', '/v1/corrector-groups?scopeKind=agent')).status).toBe(400);
  });

  test('bad bodies: 400 bad-input; unknown group: 404', async () => {
    const h = harness([]);
    for (const body of [
      { scope: { kind: 'tenant' }, name: 'x', weight: -1 },
      { scope: { kind: 'tenant' }, name: '', weight: 1 },
      { scope: { kind: 'project' }, name: 'x', weight: 1 },
      { name: 'x', weight: 1 },
    ]) {
      const res = await h.call('POST', '/v1/corrector-groups', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad-input');
    }
    expect((await h.call('PATCH', '/v1/corrector-groups/nope', { weight: 1 })).status).toBe(404);
    expect((await h.call('PATCH', '/v1/corrector-groups/nope', {})).status).toBe(400);
    expect((await h.call('GET', '/v1/corrector-groups/nope')).status).toBe(404);
  });
});

describe('expert groups (assertableBy, T200)', () => {
  async function expertGroup(h: Harness, assertableBy: unknown): Promise<string> {
    const res = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'tenant' },
      name: 'arbiter',
      weight: 5,
      assertableBy,
    });
    expect(res.status).toBe(201);
    expect(res.body.assertableBy).toEqual(assertableBy);
    return res.body.id as string;
  }

  const correct = (h: Harness, runId: string, correctorGroupId: string, token?: string) =>
    h.call(
      'POST',
      '/v1/corrections',
      { runId, items: [{ key: 'c1', verdict: 'right' }], correctorGroupId },
      token,
    );

  test('a group that needs a senior reviewer: refused for a non-reviewer, recorded for a senior one', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await expertGroup(h, { minReviewerRole: 'senior' });
    const refused = await correct(h, run.runId, classId);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'corrector-group-not-allowed' });
    expect(refused.body.error.message).toBe(
      'You can\'t correct as "arbiter": it needs a senior reviewer or above, and you aren\'t a reviewer.',
    );
    const recorded = await correct(h, run.runId, classId, SENIOR_TOKEN);
    expect(recorded.status).toBe(201);
    expect(recorded.body.expert).toBe(true);
  });

  test('a refusal is in the access audit: who the caller is rules it out', async () => {
    const run = row();
    const authz: Authz = { grants: ['*'], checked: [], recorded: [] };
    const h = harness([run], {}, authz);
    const classId = await expertGroup(h, { minReviewerRole: 'senior' });
    const refused = await correct(h, run.runId, classId);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('corrector-group-not-allowed');
    const resource = `project:${run.projectId}`;
    expect(authz.recorded).toEqual([
      {
        action: 'write',
        resource,
        decision: expect.objectContaining({
          allowed: false,
          failing: 'actor',
          reason: refused.body.error.message,
        }),
      },
    ]);
    expect(refused.body.error.details).toMatchObject({ action: 'write', resource });
  });

  test('principal kinds and ids', async () => {
    const run = row();
    const h = harness([run]);
    const usersOnly = await expertGroup(h, { principalKinds: ['user'] });
    expect((await correct(h, run.runId, usersOnly, KEY_TOKEN)).status).toBe(403);
    expect((await correct(h, run.runId, usersOnly)).status).toBe(201);
    const named = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'tenant' },
      name: 'named',
      weight: 1,
      assertableBy: { principalIds: ['user-2'] },
    });
    expect((await correct(h, run.runId, named.body.id)).status).toBe(403);
    expect((await correct(h, run.runId, named.body.id, SENIOR_TOKEN)).status).toBe(201);
  });

  test('PATCH sets the restriction, and null lifts it', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const set = await h.call('PATCH', `/v1/corrector-groups/${classId}`, {
      assertableBy: { minReviewerRole: 'admin' },
    });
    expect(set.body.assertableBy).toEqual({ minReviewerRole: 'admin' });
    expect((await correct(h, run.runId, classId, SENIOR_TOKEN)).status).toBe(403);
    const lifted = await h.call('PATCH', `/v1/corrector-groups/${classId}`, { assertableBy: null });
    expect(lifted.status).toBe(200);
    expect(lifted.body).not.toHaveProperty('assertableBy');
    const unrestricted = await correct(h, run.runId, classId);
    expect(unrestricted.status).toBe(201);
    // Recorded while the group was unrestricted: not restricted, whatever the group is later.
    expect(unrestricted.body).not.toHaveProperty('restricted');
  });

  test.each([
    ['an empty restriction', {}],
    ['an unknown key', { roles: ['senior'] }],
    ['an unknown role', { minReviewerRole: 'boss' }],
    ['an unknown principal kind', { principalKinds: ['robot'] }],
    ['no principal ids', { principalIds: [] }],
  ])('%s: 400', async (_, assertableBy) => {
    const h = harness([]);
    const res = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'tenant' },
      name: 'x',
      weight: 1,
      assertableBy,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('assertableBy');
  });
});

describe('correctorGroupApplies', () => {
  const subject = { kind: 'agent', id: 'acme.matcher', version: '1.0.0' } as const;
  test('tenant covers everything; project and agent cover their own', () => {
    const run = { projectId: projectA, subject };
    expect(correctorGroupApplies({ kind: 'tenant' }, run)).toBe(true);
    expect(correctorGroupApplies({ kind: 'project', projectId: projectA }, run)).toBe(true);
    expect(correctorGroupApplies({ kind: 'project', projectId: projectB }, run)).toBe(false);
    expect(
      correctorGroupApplies({ kind: 'agent', projectId: projectA, agentId: 'acme.matcher' }, run),
    ).toBe(true);
    expect(
      correctorGroupApplies({ kind: 'agent', projectId: projectA, agentId: 'acme.other' }, run),
    ).toBe(false);
  });
});

describe('isReplayCopy', () => {
  test('a stamped copy, or an agent turn whose output carries its replay report; nothing else', () => {
    expect(isReplayCopy({ output: {}, context: { replayOf: 'run-1' } })).toBe(true);
    expect(isReplayCopy({ output: { replay: { of: 'run-1', testRunId: 'e', tools: [] } } })).toBe(
      true,
    );
    expect(isReplayCopy({ output: { matches: [] } })).toBe(false);
    expect(isReplayCopy({ output: { replay: 'live' } })).toBe(false);
    expect(isReplayCopy({ output: [{ replay: { of: 'run-1' } }] })).toBe(false);
    expect(isReplayCopy({ output: null })).toBe(false);
    // A typed answer's own `replay` field sits under `output`, not at the top.
    expect(isReplayCopy({ output: { output: { replay: { of: 'x' } } } })).toBe(false);
  });
});

describe('whyNotAssertable', () => {
  const user = { kind: 'user', id: 'user-1' } as const;
  test('each restriction, and nothing for a caller who meets them all', () => {
    expect(whyNotAssertable({}, user)).toBeUndefined();
    expect(whyNotAssertable({ principalKinds: ['service'] }, user)).toBe(
      'only service tokens may assert it',
    );
    expect(whyNotAssertable({ principalIds: ['user-2'] }, user)).toContain("aren't one of them");
    expect(whyNotAssertable({ minReviewerRole: 'senior' }, user)).toBe(
      "it needs a senior reviewer or above, and you aren't a reviewer",
    );
    expect(
      whyNotAssertable({ minReviewerRole: 'senior' }, { ...user, reviewerRole: 'standard' }),
    ).toBe("it needs a senior reviewer or above; you're a standard reviewer");
    expect(
      whyNotAssertable(
        { principalKinds: ['user'], principalIds: ['user-1'], minReviewerRole: 'standard' },
        { ...user, reviewerRole: 'senior' },
      ),
    ).toBeUndefined();
  });
});

const PULL_REQUEST = 'https://github.com/acme/app/pull/1';
const WRONG_DECISIONS = { decisions: 'wrong', mustNotCall: ['acme.refund'] } as const;
const WRONG_ANSWER = { answer: 'wrong', why: 'It named the wrong company.' } as const;
const BY_RULE = { by: { kind: 'rule' }, at: expect.any(String) };

/** Corrects `run` with `body` as `token`'s caller and answers the new correction's id. */
async function made(
  h: Harness,
  run: KernelRunRecord,
  body: Record<string, unknown>,
  token?: string,
): Promise<string> {
  const res = await h.call('POST', '/v1/corrections', { runId: run.runId, ...body }, token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** The ids a list answers, newest first. */
async function listed(h: Harness, qs: string, token?: string): Promise<string[]> {
  const res = await h.call('GET', `/v1/corrections?${qs}`, undefined, token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.data as { id: string }[]).map((j) => j.id);
}

/**
 * One correction in each status on project A's matcher, one on another agent
 * in A, and one in project B: what the status filters and the counts read.
 */
async function seeded() {
  const runs = {
    open: row(),
    withOwner: row(),
    fixed: row(),
    beingFixed: row(),
    wontFix: row(),
    removed: row(),
    otherAgent: row({ agent: { ...agentRef('2.0.0'), id: 'acme.other' } }),
    projectB: row({ projectId: projectB }),
  };
  type Name = keyof typeof runs;
  const h = harness(Object.values(runs));
  const ids = {} as Record<Name, string>;
  for (const name of Object.keys(runs) as Name[]) {
    const body =
      name === 'withOwner'
        ? WRONG_DECISIONS
        : name === 'fixed'
          ? { answer: 'right' }
          : WRONG_ANSWER;
    ids[name] = await made(h, runs[name], body);
  }
  const fixing = await h.call('PATCH', `/v1/corrections/${ids.beingFixed}`, {
    status: 'being-fixed',
    link: PULL_REQUEST,
  });
  const declined = await h.call('PATCH', `/v1/corrections/${ids.wontFix}`, {
    status: 'wont-fix',
    reason: 'Not worth a change.',
  });
  const removed = await h.call('POST', `/v1/corrections/${ids.removed}/remove`, {});
  expect([fixing.status, declined.status, removed.status]).toEqual([200, 200, 200]);
  /** The listed corrections by name, newest first. */
  const names = async (qs: string) =>
    (await listed(h, qs)).map((id) => (Object.keys(ids) as Name[]).find((n) => ids[n] === id));
  return { h, names };
}

describe('sorted at save', () => {
  test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'wrong decisions go to the owner, even with a wrong answer',
      { ...WRONG_DECISIONS, ...WRONG_ANSWER },
      { status: 'with-owner', sortedTo: 'owner', sorted: BY_RULE },
    ],
    [
      'a wrong answer goes to Improve',
      WRONG_ANSWER,
      { status: 'open', sortedTo: 'improve', sorted: BY_RULE },
    ],
    [
      'a wrong item goes to Improve',
      { answer: 'right', items: [{ key: 'c2', verdict: 'wrong' }] },
      { status: 'open', sortedTo: 'improve', sorted: BY_RULE },
    ],
    [
      'all right is fixed, recorded right by its author',
      { decisions: 'right', answer: 'right', items: [{ key: 'c1', verdict: 'right' }] },
      {
        status: 'fixed',
        fixedIn: {
          how: 'recorded-right',
          by: { kind: 'user', id: 'user-1' },
          at: expect.any(String),
        },
      },
    ],
    [
      "an end user's is open and unsorted, for a person to sort",
      { ...WRONG_DECISIONS, participantId: 'end-user-1' },
      { status: 'open' },
    ],
  ])('%s', async (_, body, expected) => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', { runId: run.runId, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { status, sortedTo, sorted, fixedIn } = res.body;
    expect({ status, sortedTo, sorted, fixedIn }).toEqual(expected);
    expect(res.body.updatedAt).toBe(res.body.createdAt);
    // Saved so, not only answered so.
    expect((await h.call('GET', `/v1/corrections/${res.body.id}`)).body).toMatchObject(expected);
  });

  test("an end user's is sorted like the others once its project sorts end users' corrections", async () => {
    const projects = makeInMemoryProjectBinding();
    const created = await projects.projects.create(tenantId, { name: 'Acme', slug: 'acme' });
    if (created.kind !== 'ok') throw new Error(created.kind);
    const runs = [row({ projectId: created.projectId }), row({ projectId: created.projectId })];
    const h = harness(runs, {}, undefined, undefined, undefined, undefined, projects);
    const endUsers = (run: KernelRunRecord) =>
      h.call('POST', '/v1/corrections', {
        runId: run.runId,
        ...WRONG_ANSWER,
        participantId: 'end-user-1',
      });

    const before = await endUsers(runs[0] as KernelRunRecord);
    expect(before.status, JSON.stringify(before.body)).toBe(201);
    expect(before.body).toMatchObject({ status: 'open' });
    expect(before.body.sortedTo).toBeUndefined();

    // The PATCH route's own test (projects-routes) sets it over the wire.
    expect(
      await projects.projects.update(tenantId, created.projectId, { sortEndUserCorrections: true }),
    ).toEqual({ kind: 'ok' });
    const after = await endUsers(runs[1] as KernelRunRecord);
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    const { status, sortedTo, sorted } = after.body;
    expect({ status, sortedTo, sorted }).toEqual({
      status: 'open',
      sortedTo: 'improve',
      sorted: BY_RULE,
    });
  });
});

describe('PATCH /v1/corrections/:id', () => {
  const patch = (h: Harness, id: string, body: unknown) =>
    h.call('PATCH', `/v1/corrections/${id}`, body);

  test('a correction recorded right and then set wont-fix answers no fixedIn, and none when open again', async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, { answer: 'right' });
    const got = await h.call('GET', `/v1/corrections/${id}`);
    expect(got.body).toMatchObject({ status: 'fixed', fixedIn: { how: 'recorded-right' } });
    const wontFix = await patch(h, id, { status: 'wont-fix', reason: 'not ours to fix' });
    expect(wontFix.status, JSON.stringify(wontFix.body)).toBe(200);
    expect(wontFix.body.status).toBe('wont-fix');
    expect(wontFix.body).not.toHaveProperty('fixedIn');
    const reopened = await patch(h, id, { status: 'open' });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).not.toHaveProperty('fixedIn');
  });

  test('a correction a test run reopened answers reopenedIn beside its fixedIn; a status set by hand clears both', async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, { answer: 'right' });
    const fixed = (await h.call('GET', `/v1/corrections/${id}`)).body;
    const reopenedIn = {
      version: '1.3.0',
      how: 'went-back',
      by: { kind: 'user', id: 'user-2' },
      at: '2026-11-06T10:00:00.000Z',
    } as const;
    await h.binding.applyRunOutcome({
      tenantId,
      endedAt: fixed.updatedAt as string,
      changes: [{ correctionId: id, status: 'open', reopenedIn }],
    });
    const reopened = await h.call('GET', `/v1/corrections/${id}`);
    expect(reopened.body).toMatchObject({ status: 'open', fixedIn: fixed.fixedIn, reopenedIn });
    const wontFix = await patch(h, id, { status: 'wont-fix', reason: 'not ours to fix' });
    expect(wontFix.status, JSON.stringify(wontFix.body)).toBe(200);
    expect(wontFix.body).not.toHaveProperty('reopenedIn');
    expect(wontFix.body).not.toHaveProperty('fixedIn');
  });

  test('being-fixed takes a link; back to open clears it', async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, WRONG_ANSWER);
    const fixing = await patch(h, id, { status: 'being-fixed', link: PULL_REQUEST });
    expect(fixing.status, JSON.stringify(fixing.body)).toBe(200);
    expect(fixing.body).toMatchObject({
      status: 'being-fixed',
      sortedTo: 'improve',
      link: { kind: 'pull-request', url: PULL_REQUEST },
    });
    expect(fixing.body.updatedAt > fixing.body.createdAt).toBe(true);
    const reopened = await patch(h, id, { status: 'open' });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'open', sortedTo: 'improve' });
    expect(reopened.body).not.toHaveProperty('link');
  });

  test("a suggested change's link keeps its id alone; an id that isn't one: 400", async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, WRONG_ANSWER);
    const changeId = '3bca94f1-61a4-4c2e-9d0b-7f5e2a8c1d36';
    const fixing = await patch(h, id, { status: 'being-fixed', link: `sc-${changeId}` });
    expect(fixing.status, JSON.stringify(fixing.body)).toBe(200);
    expect(fixing.body.link).toEqual({ kind: 'suggested-change', id: changeId });
    const res = await patch(h, id, { status: 'being-fixed', link: 'sc-41' });
    expect([res.status, res.body.error.code, res.body.error.message]).toEqual([
      400,
      'bad-input',
      'link must be a URL, an Improve run (ir-<its id>) or a suggested change (sc-<its id>).',
    ]);
  });

  test('wont-fix needs a reason, kept as the status note; reopening clears the note', async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, WRONG_ANSWER);
    const bare = await patch(h, id, { status: 'wont-fix' });
    expect([bare.status, bare.body.error.code, bare.body.error.message]).toEqual([
      400,
      'bad-input',
      'status: "wont-fix" needs a reason.',
    ]);
    const reason = 'The team wants the old wording.';
    const declined = await patch(h, id, { status: 'wont-fix', reason });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({
      status: 'wont-fix',
      statusNote: { text: reason, by: { kind: 'user', id: 'user-1' }, at: expect.any(String) },
    });
    const reopened = await patch(h, id, { status: 'open' });
    expect(reopened.body.status).toBe('open');
    expect(reopened.body).not.toHaveProperty('statusNote');
  });

  test('a fixed correction cannot become being-fixed: 409 naming both statuses', async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, { answer: 'right' });
    const res = await patch(h, id, { status: 'being-fixed', link: PULL_REQUEST });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'correction-status-change-not-allowed',
      message: "A correction that's fixed can't become being-fixed.",
      details: { from: 'fixed', to: 'being-fixed' },
    });
  });

  test('re-sorting to the owner makes it with-owner, sorted by the person', async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, WRONG_ANSWER);
    const res = await patch(h, id, { sortedTo: 'owner' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'with-owner',
      sortedTo: 'owner',
      sorted: { by: { kind: 'user', id: 'user-1' }, at: expect.any(String) },
    });
  });

  test('an unknown or a superseded correction: 404', async () => {
    const run = row();
    const h = harness([run]);
    const first = await made(h, run, WRONG_ANSWER);
    await made(h, run, { answer: 'right' });
    for (const id of ['nope', first]) {
      const res = await patch(h, id, { status: 'wont-fix', reason: 'Not needed.' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('correction-not-found');
    }
  });

  test('a body key it does not know: 400', async () => {
    const run = row();
    const h = harness([run]);
    const id = await made(h, run, WRONG_ANSWER);
    const res = await patch(h, id, { status: 'open', note: 'x' });
    expect([res.status, res.body.error.code, res.body.error.message]).toEqual([
      400,
      'bad-input',
      'A change has sortedTo, status, link and reason, not note.',
    ]);
  });
});

describe('changing a correction and authorization', () => {
  test('a change needs publish on the agent', async () => {
    const run = row();
    const grants = [`write project:${projectA}`, `read project:${projectA}`];
    const authz: Authz = { grants, checked: [] };
    const h = harness([run], {}, authz);
    const id = await made(h, run, WRONG_ANSWER);
    const denied = await h.call('PATCH', `/v1/corrections/${id}`, { sortedTo: 'owner' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('permission-denied');
    expect(denied.body.error.message).toContain('publish on agent "acme.matcher"');
    expect(authz.checked).toContain('publish agent:acme.matcher');

    grants.push('publish agent:acme.matcher');
    const allowed = await h.call('PATCH', `/v1/corrections/${id}`, { sortedTo: 'owner' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.status).toBe('with-owner');
  });

  test("for an agent more than one project serves, a change takes write on the correction's project, never the agent's publish", async () => {
    const run = row({ projectId: projectB });
    const grants = [
      `write project:${projectB}`,
      `read project:${projectB}`,
      `write project:${projectA}`,
      'publish agent:acme.matcher',
    ];
    const authz: Authz = { grants, checked: [] };
    const served = itemProjects([
      { kind: 'agent', id: 'acme.matcher', projects: [projectA, projectB] },
    ]);
    const h = harness([run], {}, authz, undefined, served);
    const id = await made(h, run, WRONG_ANSWER);
    // A writer of the agent's first project who only reads this one.
    grants.splice(grants.indexOf(`write project:${projectB}`), 1);
    const before = authz.checked.length;
    const denied = await h.call('PATCH', `/v1/corrections/${id}`, { sortedTo: 'owner' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain(`write on project ${projectB}`);
    const asked = authz.checked.slice(before);
    expect(asked).toContain(`write project:${projectB}`);
    expect(asked).not.toContain('publish agent:acme.matcher');

    grants.push(`write project:${projectB}`);
    const allowed = await h.call('PATCH', `/v1/corrections/${id}`, { sortedTo: 'owner' });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.status).toBe('with-owner');
  });
});

describe('GET /v1/corrections: status, sorting, source, time and author', () => {
  test('status: one, not-fixed, comma-separated or repeated; removed only when asked', async () => {
    const { names } = await seeded();
    expect(await names('')).toEqual([
      'projectB',
      'otherAgent',
      'wontFix',
      'beingFixed',
      'fixed',
      'withOwner',
      'open',
    ]);
    expect(await names('status=not-fixed')).toEqual([
      'projectB',
      'otherAgent',
      'beingFixed',
      'withOwner',
      'open',
    ]);
    expect(await names('status=open,fixed')).toEqual(['projectB', 'otherAgent', 'fixed', 'open']);
    expect(await names('status=open&status=fixed')).toEqual([
      'projectB',
      'otherAgent',
      'fixed',
      'open',
    ]);
    expect(await names('status=removed')).toEqual(['removed']);
  });

  test('sortedTo, and none for the unsorted', async () => {
    const { names } = await seeded();
    expect(await names('sortedTo=none')).toEqual(['fixed']);
    expect(await names('sortedTo=owner')).toEqual(['withOwner']);
    expect(await names('sortedTo=improve&status=open')).toEqual(['projectB', 'otherAgent', 'open']);
  });

  test('from: end users (a participant, not under a restricted group) or experts (under one)', async () => {
    const r1 = row();
    const r2 = row();
    const r3 = row();
    const h = harness([r1, r2, r3]);
    const usersOnly = await h.call('POST', '/v1/corrector-groups', {
      scope: { kind: 'tenant' },
      name: 'reviewer',
      weight: 5,
      assertableBy: { principalKinds: ['user'] },
    });
    expect(usersOnly.status).toBe(201);
    const endUser = await made(h, r1, { ...WRONG_ANSWER, participantId: 'end-user-1' }, KEY_TOKEN);
    // A participant under a restricted group is an expert, and sorted as one.
    const expert = await made(h, r2, {
      ...WRONG_ANSWER,
      participantId: 'end-user-2',
      correctorGroupId: usersOnly.body.id,
    });
    const neither = await made(h, r3, WRONG_ANSWER, SENIOR_TOKEN);

    expect(await listed(h, 'from=end-users')).toEqual([endUser]);
    expect(await listed(h, 'from=experts')).toEqual([expert]);
    expect(await listed(h, 'from=all')).toEqual([neither, expert, endUser]);
    const sorting = async (id: string) => {
      const { status, sortedTo } = (await h.call('GET', `/v1/corrections/${id}`)).body;
      return { status, sortedTo };
    };
    expect(await sorting(endUser)).toEqual({ status: 'open' });
    expect(await sorting(expert)).toEqual({ status: 'open', sortedTo: 'improve' });
  });

  test('since (from, inclusive) and until (before)', async () => {
    const r1 = row();
    const r2 = row();
    const r3 = row();
    const h = harness([r1, r2, r3]);
    const first = await made(h, r1, WRONG_ANSWER);
    const second = await made(h, r2, WRONG_ANSWER);
    const third = await made(h, r3, WRONG_ANSWER);
    const createdAt = async (id: string) =>
      encodeURIComponent((await h.call('GET', `/v1/corrections/${id}`)).body.createdAt as string);
    const at = await createdAt(second);
    expect(await listed(h, `since=${at}`)).toEqual([third, second]);
    expect(await listed(h, `until=${at}`)).toEqual([first]);
    expect(await listed(h, `since=${await createdAt(first)}&until=${at}`)).toEqual([first]);
  });

  test("madeBy=me: the caller's own; any other value is a 400", async () => {
    const run = row();
    const h = harness([run]);
    const mine = await made(h, run, WRONG_ANSWER);
    const theKeys = await made(h, run, WRONG_ANSWER, KEY_TOKEN);
    expect(await listed(h, 'madeBy=me')).toEqual([mine]);
    expect(await listed(h, 'madeBy=me', KEY_TOKEN)).toEqual([theKeys]);
    const other = await h.call('GET', '/v1/corrections?madeBy=user-1');
    expect([other.status, other.body.error.message]).toEqual([
      400,
      'madeBy takes only me: the caller.',
    ]);
  });

  test('a bad status, sortedTo, from or since: 400', async () => {
    const h = harness([]);
    for (const qs of ['status=done', 'sortedTo=nobody', 'from=robots', 'since=yesterday']) {
      const res = await h.call('GET', `/v1/corrections?${qs}`);
      expect([qs, res.status, res.body.error.code]).toEqual([qs, 400, 'bad-input']);
    }
  });
});

describe('GET /v1/corrections/counts', () => {
  test("a project's corrections in each status, or one agent's; other projects not counted", async () => {
    const { h } = await seeded();
    const counts = async (qs: string) => {
      const res = await h.call('GET', `/v1/corrections/counts?${qs}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body;
    };
    const inA = `scopeKind=project&scopeId=${projectA}`;
    expect(await counts(inA)).toEqual({
      open: 2,
      beingFixed: 1,
      withOwner: 1,
      fixed: 1,
      wontFix: 1,
      removed: 1,
    });
    expect(await counts(`${inA}&agentId=acme.matcher`)).toEqual({
      open: 1,
      beingFixed: 1,
      withOwner: 1,
      fixed: 1,
      wontFix: 1,
      removed: 1,
    });
    expect(await counts(`scopeKind=project&scopeId=${projectB}`)).toEqual({
      open: 1,
      beingFixed: 0,
      withOwner: 0,
      fixed: 0,
      wontFix: 0,
      removed: 0,
    });
  });

  test('without a project scope: 400', async () => {
    const h = harness([]);
    for (const qs of ['', 'scopeKind=tenant']) {
      const res = await h.call('GET', `/v1/corrections/counts?${qs}`);
      expect([res.status, res.body.error.code, res.body.error.message]).toEqual([
        400,
        'bad-input',
        'counts needs scopeKind=project and scopeId (the project).',
      ]);
    }
  });
});

describe('removing a correction and authorization', () => {
  test('its author may remove it; anyone else needs admin on the project', async () => {
    const r1 = row();
    const r2 = row();
    const grants = [`write project:${projectA}`, `read project:${projectA}`];
    const authz: Authz = { grants, checked: [] };
    const h = harness([r1, r2], {}, authz);
    const own = await made(h, r1, WRONG_ANSWER);
    const other = await made(h, r2, WRONG_ANSWER);

    expect((await h.call('POST', `/v1/corrections/${own}/remove`, {})).status).toBe(200);
    expect(authz.checked).not.toContain(`admin project:${projectA}`);

    const denied = await h.call('POST', `/v1/corrections/${other}/remove`, {}, SENIOR_TOKEN);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({
      code: 'permission-denied',
      message: `Not allowed to remove correction "${other}".`,
    });
    expect(authz.checked).toContain(`admin project:${projectA}`);

    grants.push(`admin project:${projectA}`);
    const byAdmin = await h.call('POST', `/v1/corrections/${other}/remove`, {}, SENIOR_TOKEN);
    expect(byAdmin.status).toBe(200);

    const removed = await h.call('GET', '/v1/corrections?status=removed');
    expect(
      (removed.body.data as { id: string; status: string }[]).map((j) => [j.id, j.status]),
    ).toEqual([
      [other, 'removed'],
      [own, 'removed'],
    ]);
    expect(await listed(h, '')).toEqual([]);
  });
});

describe('GET /v1/corrections/export', () => {
  /** What an export recorded, found by kind: both events can share a millisecond. */
  async function recorded(audit: AuditEventBinding) {
    const page = await audit.query({ tenantId, limit: 100 });
    if (page.kind !== 'ok') throw new Error('query failed');
    const byKind = (kind: string): AuditEvent | undefined =>
      page.value.data.find((e) => e.kind === kind);
    return {
      count: page.value.data.length,
      started: byKind('corrections-export-started'),
      ended: byKind('corrections-exported'),
    };
  }

  /** Two corrections of the matcher in project A, one in project B, and one of another agent. */
  async function exportable(authz?: Authz) {
    const runs = {
      wrong: row(),
      right: row(),
      projectB: row({ projectId: projectB }),
      otherAgent: row({ agent: { ...agentRef('2.0.0'), id: 'acme.other' } }),
    };
    const audit = createInMemoryAuditEventBinding();
    const h = harness(Object.values(runs), {}, authz, undefined, undefined, audit);
    const ids = {
      wrong: await made(h, runs.wrong, WRONG_ANSWER),
      right: await made(h, runs.right, { answer: 'right' }),
      projectB: await made(h, runs.projectB, WRONG_ANSWER),
      otherAgent: await made(h, runs.otherAgent, WRONG_ANSWER),
    };
    return { h, audit, ids };
  }

  test("CSV is the default: a header, then the agent's corrections, with both audit events", async () => {
    const { h, audit, ids } = await exportable();
    const res = await h.get('/v1/corrections/export?agentId=acme.matcher');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="corrections.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const lines = (await res.text()).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe(
      'id,projectId,runId,agentVersion,madeBy,participantId,expert,decisions,shouldCall,mustNotCall,answer,shouldSay,why,sortedTo,status,fixedIn,reopenedIn,createdAt',
    );
    expect(lines.slice(1, -1).map((l) => l.split(',')[0])).toEqual([
      ids.projectB,
      ids.right,
      ids.wrong,
    ]);

    const events = await recorded(audit);
    expect(events.count).toBe(2);
    expect(events.started?.actor).toBe('user:user-1');
    expect(events.started?.payload).toMatchObject({
      doc: { format: 'csv', filters: { agentId: 'acme.matcher' } },
    });
    expect(events.ended?.outcome).toBe('succeeded');
    expect(events.ended?.payload).toMatchObject({ doc: { rows: 3 } });
    expect((events.ended?.payload as any).doc.exportId).toBe(
      (events.started?.payload as any).doc.exportId,
    );
  });

  test('format=jsonl: one correction per line, as the list sends it', async () => {
    const { h } = await exportable();
    const res = await h.get('/v1/corrections/export?agentId=acme.matcher&format=jsonl');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/jsonl; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="corrections.jsonl"');
    const text = await res.text();
    expect(text.endsWith('\n')).toBe(true);
    const exported = text
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    const list = await h.call('GET', '/v1/corrections?agentId=acme.matcher');
    expect(exported).toEqual(list.body.data);
  });

  test("the list's filters apply: status, and a project scope", async () => {
    const { h, ids } = await exportable();
    const fixed = await h.get(
      '/v1/corrections/export?agentId=acme.matcher&status=fixed&format=jsonl',
    );
    expect(
      (await fixed.text())
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l).id),
    ).toEqual([ids.right]);
    const inA = await h.get(
      `/v1/corrections/export?agentId=acme.matcher&scopeKind=project&scopeId=${projectA}&format=jsonl`,
    );
    expect(
      (await inA.text())
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l).id),
    ).toEqual([ids.right, ids.wrong]);
  });

  test("rows of a project the caller can't read are left out, and a scope it can't read is a 403", async () => {
    const grants = ['*'];
    const { h, audit, ids } = await exportable({ grants, checked: [] });
    grants.splice(0, grants.length, `read project:${projectA}`);

    const res = await h.get('/v1/corrections/export?agentId=acme.matcher&format=jsonl');
    expect(res.status).toBe(200);
    expect(
      (await res.text())
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l).id),
    ).toEqual([ids.right, ids.wrong]);
    expect((await recorded(audit)).ended?.payload).toMatchObject({ doc: { rows: 2 } });

    const refused = await h.call(
      'GET',
      `/v1/corrections/export?agentId=acme.matcher&scopeKind=project&scopeId=${projectB}`,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('permission-denied');
    expect((await recorded(audit)).count).toBe(2);
  });

  test.each([
    ['', 'export needs agentId'],
    ['agentId=acme.matcher&format=xml', 'format must be one of: csv, jsonl.'],
    ['agentId=acme.matcher&limit=5', 'export takes no limit or cursor'],
    ['agentId=acme.matcher&cursor=abc', 'export takes no limit or cursor'],
    ['agentId=acme.matcher&status=nope', 'status must be one of'],
    ['agentId=acme.matcher&verdict=wrong', 'verdict is gone'],
  ])('?%s is a 400 that sends and records nothing', async (qs, message) => {
    const { h, audit } = await exportable();
    const res = await h.call('GET', `/v1/corrections/export?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain(message);
    expect((await recorded(audit)).count).toBe(0);
  });

  test("a start event that can't be written is a 500, and nothing is sent", async () => {
    const run = row();
    const refusing = {
      ...createInMemoryAuditEventBinding(),
      append: async () => ({ kind: 'err', error: { message: 'audit store full' } }),
    } as unknown as AuditEventBinding;
    const h = harness([run], {}, undefined, undefined, undefined, refusing);
    await made(h, run, WRONG_ANSWER);
    const res = await h.call('GET', '/v1/corrections/export?agentId=acme.matcher');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('persistence-error');
    expect(res.body.error.message).toContain('audit store full');
    expect(res.body.data).toBeUndefined();
  });
});
