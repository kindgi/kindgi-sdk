// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How a run `POST /v1/runs` starts began (`startedBy`), from its caller:
 * a person, signed in or with their own key, is `person`; a service
 * account's key is `key`, whoever else it names; any other caller records
 * none. The body never says. Only `person` counts as attended, so for
 * automation use a service account's key: its runs are unattended.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  type Principal,
  type ResourceRef,
  delegate,
  serviceAccountPrincipal,
  systemPrincipal,
  userPrincipal,
} from '@kindgi/authz';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ApiTokenId, ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolution } from '../src/index.js';
import { startedByCaller } from '../src/routes/runs.js';

const tenantId = randomUUID() as TenantId;
const PERSON = randomUUID() as UserId;
const AGENT: Principal = { actor: { kind: 'agent', id: 'acme.desk', tenantId } };

/** Each bearer token, as the resolver answers it. */
const TOKENS: Record<string, TokenResolution> = {
  session: { tenantId, userId: PERSON },
  'persons-key': { tenantId, userId: PERSON, tokenId: 'tok-person' as ApiTokenId },
  'service-account-key': {
    tenantId,
    serviceAccountId: 'sa-automation',
    tokenId: 'tok-sa' as ApiTokenId,
  },
  // A resolver that names a person too: the key is still a service account's.
  'service-account-key-naming-a-person': {
    tenantId,
    serviceAccountId: 'sa-automation',
    tokenId: 'tok-sa-2' as ApiTokenId,
    userId: PERSON,
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
    createdAt: '2026-10-05T08:00:00.000Z' as Timestamp,
    updatedAt: '2026-10-05T08:00:00.000Z' as Timestamp,
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
    return { status: res.status, body: await res.text(), started };
  };
  return { run, started };
}

const agentRun = { agent: 'acme.desk', agentVersion: '1.0.0', input: { userMessage: 'hello' } };
const flowRun = { flow: 'acme.triage', input: { orderId: 7 } };

describe('POST /v1/runs: how the run started', () => {
  test.each([
    ['session', 'person'],
    ['persons-key', 'person'],
    ['service-account-key', 'key'],
    ['service-account-key-naming-a-person', 'key'],
  ] as const)(
    'a caller with a %s starts a run as %s, an agent turn or a flow',
    async (token, by) => {
      const { run, started } = makeApp();
      for (const body of [agentRun, flowRun]) {
        const res = await run(token, body);
        expect(res.status, res.body).toBeLessThan(300);
      }
      expect(started.map((s) => s.startedBy)).toEqual([by, by]);
    },
  );

  test("the body can't say: a service account's key claiming a person still starts as `key`", async () => {
    const { run, started } = makeApp();
    const claimed = await run('service-account-key', { ...agentRun, startedBy: 'person' });
    expect(claimed.status, claimed.body).toBeLessThan(300);
    expect(started.map((s) => s.startedBy)).toEqual(['key']);
  });
});

describe('startedByCaller', () => {
  test('a person, a service account, and every other caller', () => {
    expect(startedByCaller(userPrincipal(PERSON, tenantId), false)).toBe('person');
    expect(startedByCaller(serviceAccountPrincipal('sa-1', tenantId), false)).toBe('key');
    expect(startedByCaller(userPrincipal(PERSON, tenantId), true)).toBe('key');
    expect(startedByCaller(AGENT, false)).toBeUndefined();
    expect(startedByCaller(systemPrincipal(tenantId), false)).toBeUndefined();
    // An agent acting for a person: the person didn't start it.
    expect(
      startedByCaller(delegate(AGENT.actor, userPrincipal(PERSON, tenantId).actor), false),
    ).toBeUndefined();
    expect(startedByCaller(undefined, false)).toBeUndefined();
  });
});
