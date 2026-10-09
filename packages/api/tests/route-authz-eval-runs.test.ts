// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Eval runs and authorization (T243 A). Starting one needs `write` on the
 * project it lands in and `execute` on what it evaluates (the agent or
 * the flow); the eval-suites router's own check on the suite comes on
 * top, and isn't wired here. An eval run is read through its suite:
 * `read` on the suite to list, get or follow it, `write` to cancel it. A
 * run that isn't there is still the handler's 404, with nothing asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { EvalRunBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-eval-runs';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const PROJECT = randomUUID();

const evalRun = (runId: string, suiteId: string) => ({
  runId,
  tenantId,
  suiteId,
  suiteVersion: '1.0.0',
  kind: 'judged',
  agentRef: { agentId: 'acme.agent' },
  status: 'completed',
  dryRun: false,
  startedAt: '2026-10-08T08:00:00.000Z',
});

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
  const runs = [evalRun('e-mine', 'acme.suite-mine'), evalRun('e-theirs', 'acme.suite-theirs')];
  const evalRuns = {
    start: async () => ({ kind: 'ok', runId: 'e-new' }),
    list: async () => ({ data: runs }),
    get: async ({ runId }: { runId: string }) => runs.find((r) => r.runId === runId) ?? null,
    cancel: async ({ runId }: { runId: string }) =>
      runs.some((r) => r.runId === runId) ? { kind: 'ok' } : { kind: 'not-found' },
  } as unknown as EvalRunBinding;
  const app = createApp({
    ...createStubAppBindings(),
    evalRunBinding: evalRuns,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
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
  return { call, asked };
}

const WRITE_PROJECT = `write project:${PROJECT}`;
const START = '/v1/eval-suites/acme.suite-mine/runs';

describe('starting an eval run', () => {
  test('needs `write` on its project and `execute` on the agent it evaluates', async () => {
    const both = harness([WRITE_PROJECT, 'execute agent:acme.agent']);
    const res = await both.call('POST', START, {
      projectId: PROJECT,
      agentRef: { agentId: 'acme.agent' },
    });
    expect(res.status).toBe(201);

    const noExecute = harness([WRITE_PROJECT]);
    const refused = await noExecute.call('POST', START, {
      projectId: PROJECT,
      agentRef: { agentId: 'acme.agent' },
    });
    expect(refused.status).toBe(403);
    expect(noExecute.asked).toEqual([WRITE_PROJECT, 'execute agent:acme.agent']);

    const noWrite = harness(['execute agent:acme.agent']);
    expect(
      (
        await noWrite.call('POST', START, {
          projectId: PROJECT,
          agentRef: { agentId: 'acme.agent' },
        })
      ).status,
    ).toBe(403);
    expect(noWrite.asked).toEqual([WRITE_PROJECT]);
  });

  test('a flow candidate needs `execute` on the flow', async () => {
    const { call, asked } = harness([WRITE_PROJECT]);
    const res = await call('POST', START, { projectId: PROJECT, flowRef: { flowId: 'acme.flow' } });
    expect(res.status).toBe(403);
    expect(asked).toEqual([WRITE_PROJECT, 'execute flow:acme.flow']);
  });
});

describe('an eval run is read through its suite', () => {
  test('the list holds only runs of suites the caller may read', async () => {
    const { call } = harness(['read eval_suite:acme.suite-mine']);
    const res = await call('GET', '/v1/eval-runs');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { runId: string }[] }).data.map((r) => r.runId);
    expect(ids).toEqual(['e-mine']);
  });

  test('get and events need `read` on the suite; cancel needs `write`', async () => {
    const { call } = harness(['read eval_suite:acme.suite-mine']);
    expect((await call('GET', '/v1/eval-runs/e-mine')).status).toBe(200);
    expect((await call('GET', '/v1/eval-runs/e-theirs')).status).toBe(403);
    expect((await call('GET', '/v1/eval-runs/e-theirs/events')).status).toBe(403);
    expect((await call('POST', '/v1/eval-runs/e-mine/cancel')).status).toBe(403);

    const writer = harness(['write eval_suite:acme.suite-mine']);
    expect((await writer.call('POST', '/v1/eval-runs/e-mine/cancel')).status).toBe(200);
  });

  test("a run that isn't there is the handler's 404, with nothing asked", async () => {
    const { call, asked } = harness([]);
    expect((await call('GET', '/v1/eval-runs/e-missing')).status).toBe(404);
    expect((await call('POST', '/v1/eval-runs/e-missing/cancel')).status).toBe(404);
    expect(asked).toEqual([]);
  });
});
