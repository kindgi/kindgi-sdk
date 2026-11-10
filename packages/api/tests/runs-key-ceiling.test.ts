// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run an API key with a ceiling starts (`POST /v1/runs`) is marked with
 * it (`keyCeiling`), from the caller's key, never the body. The mark
 * changes nothing the run may do: it starts as the key's person
 * (`startedBy` `person`), as a person's own key without a ceiling does.
 * The run's read and list answer with it.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ApiTokenId, ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolution } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PERSON = randomUUID() as UserId;
const P1 = randomUUID();

/** Each bearer token, as the resolver answers it. */
const TOKENS: Record<string, TokenResolution> = {
  session: { tenantId, userId: PERSON },
  'persons-key': {
    tenantId,
    userId: PERSON,
    tokenId: 'tok-person' as ApiTokenId,
    tokenRole: 'member',
    tokenProjectId: P1,
  },
  'ceiling-key': {
    tenantId,
    userId: PERSON,
    tokenId: 'tok-ceiling' as ApiTokenId,
    capabilities: [],
    tokenRole: 'member',
    tokenProjectId: P1,
    tokenCeiling: 'sandbox',
  },
  'service-account-key': {
    tenantId,
    serviceAccountId: 'sa-automation',
    tokenId: 'tok-sa' as ApiTokenId,
  },
};

function allow(action: Action, resource: ResourceRef): Decision {
  return {
    allowed: true,
    reason: 'test: granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

function makeApp(over: Partial<KernelRunRecord> = {}) {
  const started: Record<string, unknown>[] = [];
  const stub = createStubAppBindings();
  const runId = randomUUID() as RunId;
  // The route reads the run it started back, to answer with it.
  const startedRun: KernelRunRecord = {
    runId,
    tenantId,
    projectId: P1 as ProjectId,
    flowId: 'acme.triage',
    flowVersion: '1.0.0',
    status: 'pending',
    input: {},
    dryRun: false,
    createdAt: '2026-10-05T08:00:00.000Z' as Timestamp,
    updatedAt: '2026-10-05T08:00:00.000Z' as Timestamp,
    ...over,
  };
  const kernelRuns = {
    ...stub.kernelBinding.run,
    getRun: async (_t: TenantId, id: string) => (id === runId ? startedRun : null),
    listRuns: async () => ({ data: [startedRun] }),
  } as unknown as RunBinding;
  const app = createApp({
    ...stub,
    kernelBinding: { ...stub.kernelBinding, run: kernelRuns },
    resolveToken: async (token) => TOKENS[token] ?? null,
    runHandler: {
      invokeAgent: async (input: Record<string, unknown>) => {
        started.push(input);
        return { kind: 'ok', runId, status: 'pending' };
      },
      invokeFlow: async (input: Record<string, unknown>) => {
        started.push(input);
        return { kind: 'ok', runId, status: 'pending' };
      },
      resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
    } as unknown as RunHandlerBinding,
    agentRegistry: {
      ...(stub as unknown as { agentRegistry?: object }).agentRegistry,
      get: async ({ agentId }: { agentId: string }) => ({ agentId, version: '1.0.0' }),
    } as never,
    flowRegistry: {
      get: async ({ flowId }: { flowId: string }) => ({ flowId, version: '1.0.0' }),
    } as never,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, resource) => allow(action, resource),
        checkBatch: async (_p, action, resources) => resources.map((r) => allow(action, r)),
        // Everything is in the keys' project: only the ceiling could hold a caller back.
        inProject: async () => true,
      } satisfies AuthzCheckBinding,
    },
  });
  const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.text() };
  };
  const run = (token: string, body: Record<string, unknown>) =>
    call(token, 'POST', '/v1/runs', body);
  return { run, call, started, runId };
}

const agentRun = { agent: 'acme.desk', agentVersion: '1.0.0', input: { userMessage: 'hello' } };
const flowRun = { flow: 'acme.triage', input: { orderId: 7 } };

describe('POST /v1/runs: the ceiling of the key that started the run', () => {
  test("a key with a ceiling starts an agent turn and a flow marked with it, as the key's person", async () => {
    const { run, started } = makeApp();
    for (const body of [agentRun, flowRun]) {
      const res = await run('ceiling-key', body);
      expect(res.status, res.body).toBeLessThan(300);
    }
    expect(started).toHaveLength(2);
    for (const input of started) {
      expect(input.keyCeiling).toBe('sandbox');
      expect(input.startedBy).toBe('person');
    }
  });

  test.each(['session', 'persons-key', 'service-account-key'])(
    'a caller with a %s starts runs with no mark',
    async (token) => {
      const { run, started } = makeApp();
      for (const body of [agentRun, flowRun]) {
        const res = await run(token, body);
        expect(res.status, res.body).toBeLessThan(300);
      }
      expect(started).toHaveLength(2);
      for (const input of started) expect(input).not.toHaveProperty('keyCeiling');
    },
  );

  test("the body can't say: a key without a ceiling claiming one starts unmarked", async () => {
    const { run, started } = makeApp();
    for (const body of [agentRun, flowRun]) {
      const res = await run('persons-key', { ...body, keyCeiling: 'sandbox' });
      expect(res.status, res.body).toBeLessThan(300);
    }
    expect(started).toHaveLength(2);
    for (const input of started) expect(input).not.toHaveProperty('keyCeiling');
  });
});

describe("a run's read and list answer with the mark", () => {
  test('a marked run: on its start, its read and the list', async () => {
    const { run, call, runId } = makeApp({ startedBy: 'person', keyCeiling: 'sandbox' });
    const answered = await run('ceiling-key', flowRun);
    expect(JSON.parse(answered.body)).toMatchObject({ keyCeiling: 'sandbox', startedBy: 'person' });

    const one = await call('session', 'GET', `/v1/runs/${runId}`);
    expect(one.status, one.body).toBe(200);
    expect(JSON.parse(one.body)).toMatchObject({ keyCeiling: 'sandbox' });

    const list = await call('session', 'GET', '/v1/runs');
    expect(list.status, list.body).toBe(200);
    const rows = (JSON.parse(list.body) as { data: Record<string, unknown>[] }).data;
    expect(rows.find((r) => r.runId === runId)).toMatchObject({ keyCeiling: 'sandbox' });
  });

  test('a run with none: none on its read or in the list', async () => {
    const { call, runId } = makeApp({ startedBy: 'person' });
    const one = await call('session', 'GET', `/v1/runs/${runId}`);
    expect(one.status, one.body).toBe(200);
    expect(JSON.parse(one.body)).not.toHaveProperty('keyCeiling');
    const list = await call('session', 'GET', '/v1/runs');
    const rows = (JSON.parse(list.body) as { data: Record<string, unknown>[] }).data;
    expect(rows.find((r) => r.runId === runId)).not.toHaveProperty('keyCeiling');
  });
});
