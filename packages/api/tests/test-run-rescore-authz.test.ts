// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/test-runs/{testRunId}/rescore` authorizes `write` on the project
 * the run belongs to: a `projectId` in the body can't move the check to a
 * project the caller may write. The body's is read only from a runtime
 * that doesn't record the run's project.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { ProjectId, RunId, TenantId } from '@kindgi/types';

import type { TestRun, TestRunBinding, TestRunStartInput } from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { testRunsRouters } from '../src/routes/test-runs.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const TEST_SET = 'acme.answers';
const PROJECT_A = randomUUID() as ProjectId;
const PROJECT_B = randomUUID() as ProjectId;

function completedComparison(projectId: ProjectId | undefined): TestRun {
  return {
    testRunId: randomUUID() as RunId,
    tenantId,
    ...(projectId !== undefined && { projectId }),
    testSetId: TEST_SET,
    testSetVersion: '1.0.0',
    kind: 'corrections',
    status: 'completed',
    agentRef: { agentId: 'acme.helpdesk', version: '1.0.0' },
  } as unknown as TestRun;
}

/** The router, with an authorizer that allows `may` (`<action> <type>:<id>`) and records each ask. */
function mounted(run: TestRun, may: readonly string[]) {
  const asked: string[] = [];
  const started: TestRunStartInput[] = [];
  const authorizer: Authorizer = {
    authorize: (action, getResource) => async (c, next) => {
      const r = await getResource(c);
      const ask = `${action} ${r.type}:${r.id}`;
      asked.push(ask);
      if (may.includes(ask)) return next();
      return c.json({ error: { code: 'permission-denied', message: 'denied' } }, 403);
    },
    can: async () => false,
    canFor: async () => {
      throw new Error('unused');
    },
    check: async () => {
      throw new Error('unused');
    },
    filterByCan: async () => [],
  };
  const binding = {
    get: async ({ testRunId }: { testRunId: RunId }) => (testRunId === run.testRunId ? run : null),
    start: async (input: TestRunStartInput) => {
      started.push(input);
      return { kind: 'ok', testRunId: randomUUID() as RunId };
    },
  } as unknown as TestRunBinding;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, tenantId as never);
    c.set('requestId' as never, 'req-rescore' as never);
    return next();
  });
  app.route('/', testRunsRouters(binding, undefined, undefined, authorizer).readback);
  const rescore = (body?: unknown) =>
    app.request(`/${run.testRunId as unknown as string}/rescore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { rescore, asked, started };
}

const onTestSet = `admin test_set:${TEST_SET}`;

describe("rescoring a test run: write on the run's own project", () => {
  test("a project in the body the caller may write doesn't stand in for the run's: 403, nothing started", async () => {
    const h = mounted(completedComparison(PROJECT_A), [onTestSet, `write project:${PROJECT_B}`]);
    const res = await h.rescore({ projectId: PROJECT_B });
    expect(res.status).toBe(403);
    expect(h.asked).toEqual([onTestSet, `write project:${PROJECT_A}`]);
    expect(h.started).toEqual([]);
  });

  test("with write on the run's project it starts there, whatever the body names", async () => {
    const h = mounted(completedComparison(PROJECT_A), [onTestSet, `write project:${PROJECT_A}`]);
    const res = await h.rescore({ projectId: PROJECT_B });
    expect(res.status).toBe(201);
    expect(h.started.map((s) => s.projectId)).toEqual([PROJECT_A]);
  });

  test("from a runtime that doesn't record the run's project, the body's is the one checked", async () => {
    const h = mounted(completedComparison(undefined), [onTestSet, `write project:${PROJECT_B}`]);
    expect((await h.rescore({ projectId: PROJECT_B })).status).toBe(201);
    expect(h.asked.at(-1)).toBe(`write project:${PROJECT_B}`);
    expect(h.started.map((s) => s.projectId)).toEqual([PROJECT_B]);
    // And without one, there's nothing to check it against.
    expect((await h.rescore()).status).toBe(400);
  });
});
