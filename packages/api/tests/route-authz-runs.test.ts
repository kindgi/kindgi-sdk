// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Runs and authorization: starting a run needs `execute` on the
 * agent or flow it names (one that doesn't exist keeps its 404); the run
 * list holds only runs whose project the caller may read, and their own
 * runs on a project they may run; a run that doesn't exist is still a 404
 * on its own routes, not a 403.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { encodeCursor } from '../src/routes/pagination.js';
import { createStubAppBindings } from '../src/testing/index.js';

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
// Runs that act for someone: the caller (`user-1`), and another person.
const callersOwn: KernelRunRecord = { ...record(MINE), actsFor: 'user:user-1' };
const anothersOwn: KernelRunRecord = { ...record(MINE), actsFor: 'user:user-2' };
// A key's run, or a service account's schedule's: never a person's own.
const serviceAccounts: KernelRunRecord = { ...record(MINE), actsFor: 'service_account:sa-1' };
const runs = [mine, theirs, callersOwn, anothersOwn, serviceAccounts];

type ListRuns = RunBinding['listRuns'];

function harness(grants: readonly string[], listRuns?: ListRuns) {
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
  const cancelled: string[] = [];
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
      return runs.find((r) => r.runId === runId) ?? null;
    },
    listRuns: listRuns ?? (async (_input: ListRunsInput) => ({ data: [mine, theirs] })),
    readJournal: async () => ({ kind: 'ok', value: [] }),
    cancelRun: async (_t: TenantId, runId: string) => {
      if (!runs.some((r) => r.runId === runId)) {
        return { kind: 'err', error: { code: 'run-not-found', message: 'x' } };
      }
      cancelled.push(runId);
      return { kind: 'ok', value: undefined };
    },
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
  return { call, asked, invoked, cancelled };
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

  test('naming a project needs write on it, and the refusal says to omit it', async () => {
    const named = randomUUID();
    const { call, asked, invoked } = harness(['execute agent:acme.desk']);
    const res = await call('POST', '/v1/runs', {
      agent: 'acme.desk',
      projectId: named,
      input: { userMessage: 'hi' },
    });
    expect(res.status).toBe(403);
    expect(asked).toEqual(['execute agent:acme.desk', `write project:${named}`]);
    const error = ((await res.json()) as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain(
      `naming project ${named} needs write on it; omit \`projectId\` to run in the agent's own project`,
    );
    expect(invoked).toEqual([]);

    const writer = harness(['execute agent:acme.desk', `write project:${named}`]);
    await writer.call('POST', '/v1/runs', {
      agent: 'acme.desk',
      projectId: named,
      input: { userMessage: 'hi' },
    });
    expect(writer.invoked).toEqual(['acme.desk']);
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
    expect((await call('POST', '/v1/runs/None/resume')).status).toBe(400);
  });

  test("another project's run is refused on cancel", async () => {
    const { call, asked } = harness([`read tenant:${tenantId}`]);
    const res = await call('POST', `/v1/runs/${theirs.runId}/cancel`);
    expect(res.status).toBe(403);
    expect(asked).toEqual([`write project:${THEIRS}`]);
  });
});

describe('cancelling a run of their own', () => {
  test('a runner cancels a run that acts for them: write refused, then run allowed', async () => {
    const { call, asked, cancelled } = harness([`run project:${MINE}`]);
    const res = await call('POST', `/v1/runs/${callersOwn.runId}/cancel`);
    expect(res.status).toBe(200);
    expect(asked).toEqual([`write project:${MINE}`, `run project:${MINE}`]);
    expect(cancelled).toEqual([callersOwn.runId]);
  });

  test("a runner can't cancel a run that acts for another person: write's 403", async () => {
    const { call, asked, cancelled } = harness([`run project:${MINE}`]);
    const res = await call('POST', `/v1/runs/${anothersOwn.runId}/cancel`);
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'permission-denied', details: { action: 'write' } },
    });
    expect(asked).toEqual([`write project:${MINE}`]);
    expect(cancelled).toEqual([]);
  });

  test("a runner can't cancel a run that acts for no one", async () => {
    const { call, cancelled } = harness([`run project:${MINE}`]);
    expect((await call('POST', `/v1/runs/${mine.runId}/cancel`)).status).toBe(403);
    expect(cancelled).toEqual([]);
  });

  test('a viewer cancels nothing, not even a run that acts for them', async () => {
    const { call, asked, cancelled } = harness([`read project:${MINE}`]);
    const res = await call('POST', `/v1/runs/${callersOwn.runId}/cancel`);
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({
      error: { details: { action: 'write' } },
    });
    expect(asked).toEqual([`write project:${MINE}`, `run project:${MINE}`]);
    expect(cancelled).toEqual([]);
  });

  test("an editor cancels anyone's run on write alone", async () => {
    const { call, asked, cancelled } = harness([`write project:${MINE}`]);
    expect((await call('POST', `/v1/runs/${anothersOwn.runId}/cancel`)).status).toBe(200);
    expect(asked).toEqual([`write project:${MINE}`]);
    expect(cancelled).toEqual([anothersOwn.runId]);
  });

  test('resuming stays write, even on a run of their own', async () => {
    const { call } = harness([`run project:${MINE}`]);
    const res = await call('POST', `/v1/runs/${callersOwn.runId}/resume`, {
      waitpointId: 'pause:x',
      value: {},
    });
    expect(res.status).toBe(403);
  });
});

describe('reading a run of their own', () => {
  const reads = (runId: string): [string, string][] => [
    ['GET', `/v1/runs/${runId}`],
    ['HEAD', `/v1/runs/${runId}`],
    ['GET', `/v1/runs/${runId}/journal`],
    ['GET', `/v1/runs/${runId}/stream`],
    ['HEAD', `/v1/runs/${runId}/stream`],
    ['GET', `/v1/runs/${runId}/progress`],
    ['GET', `/v1/runs/${runId}/progress/stream`],
    ['HEAD', `/v1/runs/${runId}/progress/stream`],
  ];

  test('a runner reads a run that acts for them on every read route: read refused, then run allowed', async () => {
    for (const [method, path] of reads(callersOwn.runId)) {
      const { call, asked } = harness([`run project:${MINE}`]);
      const res = await call(method, path);
      // A stream's body isn't read: its status is the check's answer.
      await res.body?.cancel();
      expect([method, path, res.status]).toEqual([method, path, 200]);
      expect(asked).toEqual([`read project:${MINE}`, `run project:${MINE}`]);
    }
  });

  test("a runner reads no run that acts for another person: read's 403 on every read route", async () => {
    for (const [method, path] of reads(anothersOwn.runId)) {
      const { call, asked } = harness([`run project:${MINE}`]);
      const res = await call(method, path);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      if (method === 'GET') {
        expect((await res.json()) as unknown).toMatchObject({
          error: { code: 'permission-denied', details: { action: 'read' } },
        });
      }
      expect(asked).toEqual([`read project:${MINE}`]);
    }
  });

  test("a runner reads no run that acts for no one, as a project's run doesn't", async () => {
    const { call } = harness([`run project:${MINE}`]);
    expect((await call('GET', `/v1/runs/${mine.runId}`)).status).toBe(403);
  });

  test("a runner reads no run that acts for a service account: read's 403 on every read route", async () => {
    for (const [method, path] of reads(serviceAccounts.runId)) {
      const { call, asked } = harness([`run project:${MINE}`]);
      const res = await call(method, path);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect(asked).toEqual([`read project:${MINE}`]);
    }
  });

  test("a viewer reads anyone's run on read alone", async () => {
    const { call, asked } = harness([`read project:${MINE}`]);
    expect((await call('GET', `/v1/runs/${anothersOwn.runId}`)).status).toBe(200);
    expect(asked).toEqual([`read project:${MINE}`]);
  });

  test('a HEAD of a run is checked as its GET', async () => {
    const { call, asked } = harness([]);
    expect((await call('HEAD', `/v1/runs/${anothersOwn.runId}`)).status).toBe(403);
    expect(asked).toEqual([`read project:${MINE}`]);
  });
});

describe('the run list for a runner', () => {
  test("it holds the runner's own runs and no one else's", async () => {
    const { call } = harness([`run project:${MINE}`], async () => ({ data: runs }));
    const body = (await (await call('GET', '/v1/runs')).json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).toEqual([callersOwn.runId]);
  });

  test("a page of only another person's runs answers no rows and the next cursor; following it reaches the runner's own", async () => {
    const next = encodeCursor({ createdAt: anothersOwn.createdAt, id: anothersOwn.runId });
    const pages: ListRuns = async (input) =>
      input.cursor === undefined
        ? { data: [anothersOwn], nextCursor: next as never }
        : { data: [callersOwn] };
    const { call } = harness([`run project:${MINE}`], pages);
    const first = (await (await call('GET', '/v1/runs?limit=1')).json()) as {
      data: { id: string }[];
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(first).toEqual({ data: [], hasMore: true, nextCursor: next });
    const second = (await (
      await call('GET', `/v1/runs?limit=1&cursor=${encodeURIComponent(next)}`)
    ).json()) as { data: { id: string }[]; hasMore: boolean };
    expect(second.data.map((r) => r.id)).toEqual([callersOwn.runId]);
    expect(second.hasMore).toBe(false);
  });
});
