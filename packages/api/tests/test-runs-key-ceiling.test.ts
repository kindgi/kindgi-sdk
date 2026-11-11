// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A test run an API key with a ceiling starts, or rescores, is marked with
 * it (`keyCeiling`), from the caller's key, never the body; the runs of its
 * cases carry it, and the test run's read and the list answer with it. A
 * rescore carries the rescoring key's mark, not the run's.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { ProjectId, RunId, TenantId } from '@kindgi/types';

import type {
  EvalGrader,
  TestRun,
  TestRunBinding,
  TestRunStartInput,
  TestRunSubjectInvokeInput,
  TestSet,
  TestSetRegistryBinding,
} from '../src/index.js';
import { createAccuracyDispatcher, createInProcessTestRunBinding } from '../src/index.js';
import { testRunsRouters } from '../src/routes/test-runs.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const testSet: TestSet = {
  id: 'acme.answers',
  tenantId,
  version: '1.0.0',
  kind: 'accuracy',
  spec: {
    cases: [
      { input: 'one', expected: 'ok' },
      { input: 'two', expected: 'ok' },
    ],
  },
} as unknown as TestSet;

const passes: EvalGrader = {
  id: 'stub:pass',
  grade: async () => ({ pass: true, score: 1 }),
};

/** The routers as the caller sees them; `ceiling` is their key's, if it has one. */
function mounted(binding: TestRunBinding, ceiling?: 'sandbox') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, tenantId as never);
    c.set('requestId' as never, 'req-key-ceiling' as never);
    if (ceiling !== undefined) c.set('tokenCeiling', ceiling);
    return next();
  });
  const routers = testRunsRouters(binding);
  app.route('/v1/test-sets', routers.start);
  app.route('/v1/test-runs', routers.readback);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, post };
}

/** The in-process binding, with every case's invoke recorded. */
function inProcess() {
  const invoked: TestRunSubjectInvokeInput[] = [];
  const registry = {
    get: async ({ testSetId }: { testSetId: string }) =>
      testSetId === testSet.id ? testSet : null,
  } as unknown as TestSetRegistryBinding;
  const binding = createInProcessTestRunBinding({
    testSetRegistry: registry,
    subject: {
      invoke: async (input) => {
        invoked.push(input);
        return { output: 'ok' };
      },
    },
    dispatchers: { accuracy: createAccuracyDispatcher({ grader: passes }) },
  });
  return { binding, invoked };
}

async function settled(binding: TestRunBinding, testRunId: string): Promise<TestRun> {
  for (let i = 0; i < 400; i++) {
    const run = await binding.get({ tenantId, testRunId: testRunId as RunId });
    if (run !== null && run.status !== 'running' && run.status !== 'pending') return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the test run did not settle');
}

/** The test run's row in `GET /v1/test-runs`, as the wire has it. */
async function listed(
  app: ReturnType<typeof mounted>['app'],
  testRunId: string,
): Promise<Record<string, unknown> | undefined> {
  const res = await app.request('/v1/test-runs');
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: Record<string, unknown>[] };
  return data.find((row) => row.testRunId === testRunId);
}

const start = { projectId, agentRef: { agentId: 'acme.desk', version: '1.0.0' } };

describe('POST /v1/test-sets/{testSetId}/runs: the ceiling of the key that started it', () => {
  test("a key with a ceiling starts a test run marked with it; its cases' runs, its read and the list carry it", async () => {
    const { binding, invoked } = inProcess();
    const { app, post } = mounted(binding, 'sandbox');
    const res = await post(`/v1/test-sets/${testSet.id}/runs`, start);
    expect(res.status).toBe(201);
    const { testRunId } = (await res.json()) as { testRunId: string };

    const run = await settled(binding, testRunId);
    expect(run.status).toBe('completed');
    expect(run.keyCeiling).toBe('sandbox');
    expect(invoked).toHaveLength(2);
    for (const input of invoked) expect(input.keyCeiling).toBe('sandbox');

    const read = await app.request(`/v1/test-runs/${testRunId}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ testRunId, keyCeiling: 'sandbox' });

    expect(await listed(app, testRunId)).toMatchObject({ keyCeiling: 'sandbox' });
  });

  test("the body can't say: a caller with no ceiling claiming one starts it unmarked", async () => {
    const { binding, invoked } = inProcess();
    const { app, post } = mounted(binding);
    const res = await post(`/v1/test-sets/${testSet.id}/runs`, { ...start, keyCeiling: 'sandbox' });
    expect(res.status).toBe(201);
    const { testRunId } = (await res.json()) as { testRunId: string };

    const run = await settled(binding, testRunId);
    expect(run).not.toHaveProperty('keyCeiling');
    expect(invoked).toHaveLength(2);
    for (const input of invoked) expect(input).not.toHaveProperty('keyCeiling');

    const read = await app.request(`/v1/test-runs/${testRunId}`);
    expect(read.status).toBe(200);
    expect(await read.json()).not.toHaveProperty('keyCeiling');

    const row = await listed(app, testRunId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('keyCeiling');
  });
});

describe("POST /v1/test-runs/{testRunId}/rescore: the rescoring key's mark", () => {
  /** A completed comparison to rescore, marked or not, and each start recorded. */
  function rescorable(mark?: 'sandbox') {
    const run = {
      testRunId: randomUUID() as RunId,
      tenantId,
      projectId,
      testSetId: testSet.id,
      testSetVersion: '1.0.0',
      kind: 'corrections',
      status: 'completed',
      agentRef: { agentId: 'acme.desk', version: '1.0.0' },
      ...(mark !== undefined && { keyCeiling: mark }),
    } as unknown as TestRun;
    const started: TestRunStartInput[] = [];
    const binding = {
      get: async ({ testRunId }: { testRunId: RunId }) =>
        testRunId === run.testRunId ? run : null,
      start: async (input: TestRunStartInput) => {
        started.push(input);
        return { kind: 'ok', testRunId: randomUUID() as RunId };
      },
    } as unknown as TestRunBinding;
    return { run, binding, started };
  }

  test('a key with a ceiling rescores marked with it', async () => {
    const { run, binding, started } = rescorable();
    const { post } = mounted(binding, 'sandbox');
    expect((await post(`/v1/test-runs/${run.testRunId}/rescore`, {})).status).toBe(201);
    expect(started.map((s) => s.keyCeiling)).toEqual(['sandbox']);
  });

  test("a marked run rescored by a caller with no ceiling isn't marked, whatever the body says", async () => {
    const { run, binding, started } = rescorable('sandbox');
    const { post } = mounted(binding);
    const res = await post(`/v1/test-runs/${run.testRunId}/rescore`, { keyCeiling: 'sandbox' });
    expect(res.status).toBe(201);
    expect(started).toHaveLength(1);
    expect(started[0]).not.toHaveProperty('keyCeiling');
  });
});
