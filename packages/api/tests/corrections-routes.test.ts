// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/corrections` and `/v1/corrector-groups`: correcting an item of a finished
 * run, supersede, list filters, removal, and the corrector-group CRUD.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
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
  return { call, binding, reads: counts };
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
  test('with a pointer: stores the item value and the run copy', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);

    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: 'c2', pointer: '/matches/1', rank: 1 },
      verdict: 'yes',
      reason: 'Right company.',
      correctorGroupId: classId,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      runId: run.runId,
      projectId: projectA,
      subject: { kind: 'agent', id: 'acme.matcher', version: '2.0.0' },
      item: { key: 'c2', pointer: '/matches/1', rank: 1 },
      verdict: 'yes',
      reason: 'Right company.',
      correctorGroupId: classId,
    });

    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.itemValue).toEqual({ id: 'c2' });
    expect(got.body.run).toMatchObject({
      runId: run.runId,
      input: { query: 'acme' },
      output: { matches: [{ id: 'c1' }, { id: 'c2' }] },
    });
  });

  test('stores a correction and echoes it back on read', async () => {
    const run = row();
    const h = harness([run]);
    const correction = {
      calls: [{ tool: 'acme.refund', args: { amount: 25 } }],
      notCalled: ['acme.email'],
    };
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction,
    });
    expect(res.status).toBe(201);
    expect(res.body.correction).toEqual(correction);
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body.correction).toEqual(correction);
  });

  test('a tool in both calls and notCalled is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [{ tool: 'acme.refund', args: {} }], notCalled: ['acme.refund'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain("can't be in both");
  });

  test('a correction with neither a call nor a must-not-call is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [], notCalled: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain('at least one of calls or notCalled');
  });

  test('a correction on any item but the fixed one is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: 'answer', pointer: '' },
      verdict: 'no',
      correction: { calls: [{ tool: 'acme.refund', args: {} }], notCalled: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain(CORRECTION_ITEM.key);
  });

  test('a correction on the fixed key but a non-empty pointer is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: CORRECTION_ITEM.key, pointer: '/matches/0' },
      verdict: 'no',
      correction: { calls: [{ tool: 'acme.refund', args: {} }], notCalled: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('whole output');
  });

  test('an ordinary correction on the reserved item is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain('reserved');
  });

  test('an ordinary correction on the reserved key at any pointer is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: CORRECTION_ITEM.key, pointer: '/matches/0' },
      verdict: 'yes',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('reserved');
  });

  test('an ordinary caller key the reserved key no longer shadows is accepted', async () => {
    const run = row({ output: { decision: 'refund' } });
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: 'decision', pointer: '/decision' },
      verdict: 'yes',
    });
    expect(res.status).toBe(201);
  });

  test('a correction call with oversized args is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: {
        calls: [{ tool: 'acme.refund', args: { note: 'x'.repeat(4100) } }],
        notCalled: [],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('4000');
  });

  test('a correction call with an over-long tool name is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [{ tool: `acme.${'z'.repeat(220)}`, args: {} }], notCalled: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('200');
  });

  test('a notCalled tool name that is too long is a 400', async () => {
    const run = row();
    const h = harness([run]);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [], notCalled: [`acme.${'z'.repeat(220)}`] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('200');
  });

  test('a second correction by the same caller on the same item replaces the first (counts once)', async () => {
    const run = row();
    const h = harness([run]);
    const post = (amount: number) =>
      h.call('POST', '/v1/corrections', {
        runId: run.runId,
        item: { ...CORRECTION_ITEM },
        verdict: 'no',
        correction: { calls: [{ tool: 'acme.refund', args: { amount } }], notCalled: [] },
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
    expect(list.body.data[0].correction).toEqual({
      calls: [{ tool: 'acme.refund', args: { amount: 40 } }],
      notCalled: [],
    });
  });

  test('a correction may name tools the corrected version has', async () => {
    const run = row();
    const h = harness([run], {}, undefined, registryWithTools('acme.refund', 'acme.email'));
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: {
        calls: [{ tool: 'acme.refund', args: { amount: 25 } }],
        notCalled: ['acme.email'],
      },
    });
    expect(res.status).toBe(201);
  });

  test('a correction naming a call tool the version lacks is a 400', async () => {
    const run = row();
    const h = harness([run], {}, undefined, registryWithTools('acme.refund'));
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [{ tool: 'acme.ghost', args: {} }], notCalled: [] },
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
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [], notCalled: ['acme.ghost'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('acme.ghost');
  });

  test('an unknown tool is allowed when the corrected version cannot be resolved', async () => {
    const run = row();
    const h = harness([run], {}, undefined, registryVersionGone);
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [{ tool: 'acme.ghost', args: {} }], notCalled: [] },
    });
    expect(res.status).toBe(201);
  });

  test('a flow subject skips the tool check (best-effort)', async () => {
    const { agent: _agent, ...flowRun } = row();
    const h = harness([flowRun], {}, undefined, registryWithTools('acme.refund'));
    const res = await h.call('POST', '/v1/corrections', {
      runId: flowRun.runId,
      item: { ...CORRECTION_ITEM },
      verdict: 'no',
      correction: { calls: [{ tool: 'acme.ghost', args: {} }], notCalled: [] },
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
        item: { key: 'c1' },
        verdict: 'no',
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
      item: { key: 'c1' },
      verdict: 'no',
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
      item: { key: 'c1' },
      verdict: 'no',
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
      item: { key: 'c1' },
      verdict: 'no',
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
      item: { key: 'c9', pointer: '/matches/9' },
      verdict: 'yes',
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
      item: { key: 'c1' },
      verdict: 'yes',
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
      { runId: run.runId, item: { key: 'c1' }, verdict: 'maybe', correctorGroupId: classId },
      { runId: run.runId, item: {}, verdict: 'yes', correctorGroupId: classId },
      {
        runId: run.runId,
        item: { key: 'c1', pointer: 'matches' },
        verdict: 'yes',
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
    const body = { runId: run.runId, item: { key: 'c1' }, correctorGroupId: classId };
    const first = await h.call('POST', '/v1/corrections', { ...body, verdict: 'yes' });
    const second = await h.call('POST', '/v1/corrections', { ...body, verdict: 'no' });
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
      item: { key: 'c1' },
      verdict: 'yes',
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
      item: { key: 'c1' },
      verdict: 'yes',
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
      item: { key: 'c1' },
      correctorGroupId: classId,
      verdict: 'yes',
    };
    await h.call('POST', '/v1/corrections', { ...body, participantId: 'end-user-1' });
    await h.call('POST', '/v1/corrections', { ...body, participantId: 'end-user-2' });
    const live = await h.call('GET', `/v1/corrections?runId=${run.runId}`);
    expect(live.body.data).toHaveLength(2);
  });

  test('assertedBy comes from the principal, never the body', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    const body = {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
      correctorGroupId: classId,
      assertedBy: { kind: 'user', id: 'someone-else' },
    };
    const asUser = await h.call('POST', '/v1/corrections', body, USER_TOKEN);
    expect(asUser.body.assertedBy).toEqual({ kind: 'user', id: 'user-1' });
    const asKey = await h.call('POST', '/v1/corrections', body, KEY_TOKEN);
    expect(asKey.body.assertedBy).toEqual({ kind: 'service', id: 'key-1' });
  });
});

describe('correcting and authorization', () => {
  test("correcting a run needs write on the run's project, as cancelling one does", async () => {
    const run = row();
    const project = run.projectId as unknown as string;
    const granted: Authz = { grants: [`write project:${project}`], checked: [] };
    const allowed = await harness([run], {}, granted).call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
    });
    expect(allowed.status).toBe(201);
    expect(granted.checked).toContain(`write project:${project}`);

    const denied = await harness(
      [run],
      {},
      { grants: [`read project:${project}`], checked: [] },
    ).call('POST', '/v1/corrections', { runId: run.runId, item: { key: 'c1' }, verdict: 'yes' });
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
      item: { key: 'c1' },
      verdict: 'yes',
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
      item: { key: 'c1' },
      verdict: 'yes',
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
        item: { key: 'c1' },
        verdict: 'yes',
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
      item: { key: 'c1' },
      verdict: 'yes',
    });
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body.run.context.toolEnv).toEqual({ 'acme.lookup': { ORDERS_REGION: 'us' } });
  });

  test('a turn that never waited at the gate has no decision kept', async () => {
    const run = turn();
    const h = harness([run], { messages, journal });
    const res = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
    });
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body.run.context).not.toHaveProperty('sessionApproval');
  });

  test('a second correction of the run does not read it again', async () => {
    const run = turn();
    const h = harness([run], { messages, journal });
    await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: 'c1' },
      verdict: 'yes',
    });
    expect(h.reads).toEqual([1, 1]);
    const second = await h.call('POST', '/v1/corrections', {
      runId: run.runId,
      item: { key: 'c2' },
      verdict: 'no',
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
        item: { key: 'c1' },
        verdict: 'yes',
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
      item: { key: 'c1' },
      verdict: 'yes',
    });
    expect(res.status).toBe(201);
    const got = await h.call('GET', `/v1/corrections/${res.body.id}`);
    expect(got.body.run.context).toBeUndefined();
    // Its journal was read (for tool calls), its conversation never.
    expect(h.reads[0]).toBe(0);
  });
});

describe('GET /v1/corrections', () => {
  test('filters by run, agent and version, and verdict', async () => {
    const r1 = row();
    const r2 = row({ agent: agentRef('3.0.0') });
    const { agent: _agent, ...flowRun } = row({ flowId: 'acme.other' });
    const r3: KernelRunRecord = flowRun;
    const h = harness([r1, r2, r3]);
    const classId = await tenantClass(h);
    const correct = (run: KernelRunRecord, key: string, verdict: 'yes' | 'no') =>
      h.call('POST', '/v1/corrections', {
        runId: run.runId,
        item: { key },
        verdict,
        correctorGroupId: classId,
      });
    await correct(r1, 'a', 'yes');
    await correct(r1, 'b', 'no');
    await correct(r2, 'a', 'yes');
    await correct(r3, 'a', 'no');

    const list = async (qs: string) =>
      (await h.call('GET', `/v1/corrections?${qs}`)).body.data as {
        runId: string;
        verdict: string;
      }[];

    expect(await list(`runId=${r1.runId}`)).toHaveLength(2);
    expect(await list('agentId=acme.matcher')).toHaveLength(3);
    const v3 = await list('agentId=acme.matcher&agentVersion=3.0.0');
    expect(v3.map((j) => j.runId)).toEqual([r2.runId]);
    expect(await list('verdict=no')).toHaveLength(2);
    expect(await list('flowId=acme.other')).toHaveLength(1);
    expect(await list(`correctorGroupId=${classId}`)).toHaveLength(4);
  });

  test('agentVersion without agentId, or an unknown verdict: 400', async () => {
    const h = harness([]);
    const a = await h.call('GET', '/v1/corrections?agentVersion=1.0.0');
    expect(a.status).toBe(400);
    const b = await h.call('GET', '/v1/corrections?verdict=maybe');
    expect(b.status).toBe(400);
  });

  test('pages with limit and nextCursor fields on the wire shape', async () => {
    const run = row();
    const h = harness([run]);
    const classId = await tenantClass(h);
    for (const key of ['a', 'b', 'c']) {
      await h.call('POST', '/v1/corrections', {
        runId: run.runId,
        item: { key },
        verdict: 'yes',
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
      item: { key: 'c1' },
      verdict: 'yes',
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
      { runId, item: { key: 'c1' }, verdict: 'yes', correctorGroupId },
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
    expect(isReplayCopy({ output: { replay: { of: 'run-1', evalRunId: 'e', tools: [] } } })).toBe(
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
