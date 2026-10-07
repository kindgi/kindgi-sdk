// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Runs and authorization (T243 A): starting a run needs `execute` on the
 * agent or flow it names (one that doesn't exist keeps its 404); the run
 * list holds only runs whose project the caller may read; a run that
 * doesn't exist is still a 404 on its own routes, not a 403.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import { createStubAppBindings } from '@kindgi/testing';
import type { ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  FlowRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = 'route-authz-runs';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const MINE = randomUUID() as ProjectId;
const THEIRS = randomUUID() as ProjectId;

function record(projectId: ProjectId): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId,
    flowId: 'acme.triage',
    flowVersion: '1.0.0',
    status: 'completed',
    input: {},
    dryRun: false,
    createdAt: '2026-10-07T08:00:00.000Z' as Timestamp,
    updatedAt: '2026-10-07T08:00:01.000Z' as Timestamp,
  };
}
const mine = record(MINE);
const theirs = record(THEIRS);

function harness(grants: readonly string[]) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const invoked: string[] = [];
  const runHandler = {
    invokeAgent: async (input: { agentId: string }) => {
      invoked.push(input.agentId);
      return { kind: 'err', error: { code: 'agent-not-found', message: 'test: no such agent' } };
    },
    invokeFlow: async () => ({ kind: 'err', error: { code: 'flow-not-found', message: 'x' } }),
    resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'x' } }),
  } as unknown as RunHandlerBinding;
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    // As Postgres's uuid cast does, a malformed id fails the query.
    getRun: async (_t: TenantId, runId: string) => {
      if (!UUID.test(runId)) throw new Error(`invalid input syntax for type uuid: "${runId}"`);
      return [mine, theirs].find((r) => r.runId === runId) ?? null;
    },
    listRuns: async (_input: ListRunsInput) => ({ data: [mine, theirs], hasMore: false }),
    cancelRun: async () => ({ kind: 'err', error: { code: 'run-not-found', message: 'x' } }),
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler,
    agentRegistry: {
      get: async ({ agentId }: { agentId: string }) =>
        agentId === 'acme.desk' ? ({ id: 'acme.desk' } as never) : null,
    } as unknown as AgentRegistryBinding,
    flowRegistry: { get: async () => null } as unknown as FlowRegistryBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { call, asked, invoked };
}

describe('starting a run', () => {
  test('needs execute on the agent it names: refused 403 before the run handler', async () => {
    const { call, asked, invoked } = harness([]);
    const res = await call('POST', '/v1/runs', {
      agent: 'acme.desk',
      input: { userMessage: 'hi' },
    });
    expect(res.status).toBe(403);
    expect(asked).toEqual(['execute agent:acme.desk']);
    expect(invoked).toEqual([]);
  });

  test('with execute, it reaches the run handler', async () => {
    const { call, invoked } = harness(['execute agent:acme.desk']);
    await call('POST', '/v1/runs', { agent: 'acme.desk', input: { userMessage: 'hi' } });
    expect(invoked).toEqual(['acme.desk']);
  });

  test("an agent that doesn't exist keeps its 404, unchecked", async () => {
    const { call, asked } = harness([]);
    const res = await call('POST', '/v1/runs', {
      agent: 'acme.nobody',
      input: { userMessage: 'hi' },
    });
    expect(res.status).toBe(404);
    expect(asked).toEqual([]);
  });
});

describe('the run list and a run that is not there', () => {
  test('lists only runs whose project the caller may read', async () => {
    const { call } = harness([`read project:${MINE}`]);
    const body = (await (await call('GET', '/v1/runs')).json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).toEqual([mine.runId]);
  });

  test("a run that doesn't exist is the handler's 404 on cancel, not a 403", async () => {
    const { call } = harness([`read tenant:${tenantId}`]);
    const res = await call('POST', `/v1/runs/${randomUUID()}/cancel`);
    expect(res.status).toBe(404);
  });

  test("an id that isn't a run id is never looked up: the route's 400, not a 500", async () => {
    const { call } = harness([`read tenant:${tenantId}`]);
    expect((await call('GET', '/v1/runs/None')).status).toBe(400);
    expect((await call('POST', '/v1/runs/None/cancel')).status).toBe(400);
    // Resume answers with its own refusal.
    expect((await call('POST', '/v1/runs/None/resume')).status).toBe(422);
  });

  test("another project's run is refused on cancel", async () => {
    const { call, asked } = harness([`read tenant:${tenantId}`]);
    const res = await call('POST', `/v1/runs/${theirs.runId}/cancel`);
    expect(res.status).toBe(403);
    expect(asked).toEqual([`write project:${THEIRS}`]);
  });
});
