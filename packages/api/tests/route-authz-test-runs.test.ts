// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test runs and authorization (T243 A). Starting one needs `execute` on
 * the test set, `write` on the project it lands in and `execute` on what it
 * evaluates (the agent or the flow), asked in that order by the start
 * route itself (the test-sets router's admin check skips it). A test run is read through its test set:
 * `read` on the test set to list, get or follow it, `write` to cancel it. A
 * run that isn't there is still the handler's 404, with nothing asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TestRunBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-test-runs';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const PROJECT = randomUUID();

const testRun = (testRunId: string, testSetId: string) => ({
  testRunId,
  tenantId,
  testSetId,
  testSetVersion: '1.0.0',
  kind: 'corrections',
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
  const runs = [
    testRun('e-mine', 'acme.test-set-mine'),
    testRun('e-theirs', 'acme.test-set-theirs'),
  ];
  const testRuns = {
    start: async () => ({ kind: 'ok', testRunId: 'e-new' }),
    list: async () => ({ data: runs }),
    get: async ({ testRunId }: { testRunId: string }) =>
      runs.find((r) => r.testRunId === testRunId) ?? null,
    cancel: async ({ testRunId }: { testRunId: string }) =>
      runs.some((r) => r.testRunId === testRunId) ? { kind: 'ok' } : { kind: 'not-found' },
  } as unknown as TestRunBinding;
  const app = createApp({
    ...createStubAppBindings(),
    testRunBinding: testRuns,
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

const EXECUTE_TEST_SET = 'execute test_set:acme.test-set-mine';
const WRITE_PROJECT = `write project:${PROJECT}`;
const START = '/v1/test-sets/acme.test-set-mine/runs';

describe('starting a test run', () => {
  test('needs `execute` on the test set, `write` on its project and `execute` on the agent it evaluates', async () => {
    const both = harness([EXECUTE_TEST_SET, WRITE_PROJECT, 'execute agent:acme.agent']);
    const res = await both.call('POST', START, {
      projectId: PROJECT,
      agentRef: { agentId: 'acme.agent' },
    });
    expect(res.status).toBe(201);

    const noExecute = harness([EXECUTE_TEST_SET, WRITE_PROJECT]);
    const refused = await noExecute.call('POST', START, {
      projectId: PROJECT,
      agentRef: { agentId: 'acme.agent' },
    });
    expect(refused.status).toBe(403);
    expect(noExecute.asked).toEqual([EXECUTE_TEST_SET, WRITE_PROJECT, 'execute agent:acme.agent']);

    const noWrite = harness([EXECUTE_TEST_SET, 'execute agent:acme.agent']);
    expect(
      (
        await noWrite.call('POST', START, {
          projectId: PROJECT,
          agentRef: { agentId: 'acme.agent' },
        })
      ).status,
    ).toBe(403);
    expect(noWrite.asked).toEqual([EXECUTE_TEST_SET, WRITE_PROJECT]);

    const noTestSet = harness([WRITE_PROJECT, 'execute agent:acme.agent']);
    expect(
      (
        await noTestSet.call('POST', START, {
          projectId: PROJECT,
          agentRef: { agentId: 'acme.agent' },
        })
      ).status,
    ).toBe(403);
    expect(noTestSet.asked).toEqual([EXECUTE_TEST_SET]);
  });

  test('a flow candidate needs `execute` on the flow', async () => {
    const { call, asked } = harness([EXECUTE_TEST_SET, WRITE_PROJECT]);
    const res = await call('POST', START, { projectId: PROJECT, flowRef: { flowId: 'acme.flow' } });
    expect(res.status).toBe(403);
    expect(asked).toEqual([EXECUTE_TEST_SET, WRITE_PROJECT, 'execute flow:acme.flow']);
  });
});

describe('a test run is read through its test set', () => {
  test('the list holds only runs of test sets the caller may read', async () => {
    const { call } = harness(['read test_set:acme.test-set-mine']);
    const res = await call('GET', '/v1/test-runs');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: { testRunId: string }[] }).data.map(
      (r) => r.testRunId,
    );
    expect(ids).toEqual(['e-mine']);
  });

  test('get and events need `read` on the test set; cancel needs `write`', async () => {
    const { call } = harness(['read test_set:acme.test-set-mine']);
    expect((await call('GET', '/v1/test-runs/e-mine')).status).toBe(200);
    expect((await call('GET', '/v1/test-runs/e-theirs')).status).toBe(403);
    expect((await call('GET', '/v1/test-runs/e-theirs/events')).status).toBe(403);
    expect((await call('POST', '/v1/test-runs/e-mine/cancel')).status).toBe(403);

    const writer = harness(['write test_set:acme.test-set-mine']);
    expect((await writer.call('POST', '/v1/test-runs/e-mine/cancel')).status).toBe(200);
  });

  test("a run that isn't there is the handler's 404, with nothing asked", async () => {
    const { call, asked } = harness([]);
    expect((await call('GET', '/v1/test-runs/e-missing')).status).toBe(404);
    expect((await call('POST', '/v1/test-runs/e-missing/cancel')).status).toBe(404);
    expect(asked).toEqual([]);
  });
});
