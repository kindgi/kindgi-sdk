// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The key a run `POST /v1/runs` starts came with (`callerTokenId`), from
 * its caller: an API key's id, a person's or a service account's; none for
 * a sign-in session. The body never says. Two keys of one person share a
 * principal, so it's what a runtime tells them apart by.
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

/** Each bearer token, as the resolver answers it. */
const TOKENS: Record<string, TokenResolution> = {
  session: { tenantId, userId: PERSON },
  'persons-key': { tenantId, userId: PERSON, tokenId: 'tok-person' as ApiTokenId },
  'persons-other-key': { tenantId, userId: PERSON, tokenId: 'tok-person-2' as ApiTokenId },
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

function makeApp() {
  const started: Record<string, unknown>[] = [];
  const stub = createStubAppBindings();
  const runId = randomUUID() as RunId;
  // The route reads the run it started back, to answer with it.
  const startedRun: KernelRunRecord = {
    runId,
    tenantId,
    projectId: randomUUID() as ProjectId,
    flowId: 'acme.triage',
    flowVersion: '1.0.0',
    status: 'pending',
    input: {},
    dryRun: false,
    createdAt: '2026-11-07T08:00:00.000Z' as Timestamp,
    updatedAt: '2026-11-07T08:00:00.000Z' as Timestamp,
  };
  const kernelRuns = {
    ...stub.kernelBinding.run,
    getRun: async (_t: TenantId, id: string) => (id === runId ? startedRun : null),
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
      } satisfies AuthzCheckBinding,
    },
  });
  const run = async (token: string, body: Record<string, unknown>) => {
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };
  return { run, started };
}

const agentRun = { agent: 'acme.desk', agentVersion: '1.0.0', input: { userMessage: 'hello' } };
const flowRun = { flow: 'acme.triage', input: { orderId: 7 } };

describe('POST /v1/runs: the key the run came with', () => {
  test.each([
    ['persons-key', 'tok-person'],
    ['persons-other-key', 'tok-person-2'],
    ['service-account-key', 'tok-sa'],
  ] as const)(
    'a run started with %s carries its id, an agent turn or a flow',
    async (token, id) => {
      const { run, started } = makeApp();
      for (const body of [agentRun, flowRun]) {
        const res = await run(token, body);
        expect(res.status, res.body).toBeLessThan(300);
      }
      expect(started.map((s) => s.callerTokenId)).toEqual([id, id]);
    },
  );

  test('a sign-in session carries none', async () => {
    const { run, started } = makeApp();
    for (const body of [agentRun, flowRun]) {
      const res = await run('session', body);
      expect(res.status, res.body).toBeLessThan(300);
    }
    expect(started).toHaveLength(2);
    for (const input of started) expect(input).not.toHaveProperty('callerTokenId');
  });

  test("the body can't say: a session naming a key, or a key naming another, carries the caller's", async () => {
    const { run, started } = makeApp();
    const session = await run('session', { ...agentRun, callerTokenId: 'tok-person' });
    expect(session.status, session.body).toBeLessThan(300);
    const key = await run('persons-key', { ...flowRun, callerTokenId: 'tok-sa' });
    expect(key.status, key.body).toBeLessThan(300);
    expect(started[0]).not.toHaveProperty('callerTokenId');
    expect(started[1]?.callerTokenId).toBe('tok-person');
  });
});
