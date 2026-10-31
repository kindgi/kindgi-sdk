// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { Cursor, ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  CorrectionRegistryBinding,
  EvalGrader,
  FreezeTestSetInput,
  FrozenTestSet,
  ItemReference,
  ReferenceScopeBinding,
  RunHandlerBinding,
  TestRun,
  TestRunBinding,
  TestRunPage,
  TestRunStatus,
  TestRunSubjectInvokeOutcome,
  TestRunSubjectInvoker,
  TestSet,
  TestSetFreezeBinding,
  TestSetKind,
  TestSetRegistryBinding,
  TokenResolver,
} from '../src/index.js';
import { createAccuracyDispatcher, createInProcessTestRunBinding } from '../src/index.js';

/**
 * Test-run route tests. The registry + run binding are
 * both caller-plugged. The registry uses the same in-memory pattern
 * as `test-sets-routes.test.ts`; the run binding uses the reference
 * `createInProcessTestRunBinding` with a synthetic subject invoker
 * and a deterministic grader. Covers start (accuracy happy path,
 * dryRun, unknown test set, both/neither ref, idempotency replay,
 * dispatcher-not-registered for the other five kinds), list (filter
 * matrix), get, cancel (roundtrip + already-terminal), SSE (event
 * ordering + terminal), unmounted-route.
 */

const tenantId = randomUUID() as TenantId;
// The test-run start body carries `projectId` (content-scope anchor).
// The in-process reference binding doesn't validate against a real
// `projects` table (no storage) — any non-empty string satisfies the
// route's parser; the storage adapter (the Postgres test-run registry adapter, `test-run-registry-
// postgres`) is the one that surfaces `project-not-found` via FK.
const TEST_PROJECT_ID = randomUUID();
const TOKEN = 'test-runs-token-abc';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  return null;
};

/** The same token as a person, for the suites that check authorization. */
const resolveUserToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-editor' as UserId } : null;

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

// ---------- in-memory registry (mirrors test-sets test) ----------

function makeInMemoryRegistry(): TestSetRegistryBinding {
  const store = new Map<string, Map<string, TestSet>>();
  const latest = (versions: Map<string, TestSet>): TestSet | null => {
    const arr = [...versions.values()];
    return arr[arr.length - 1] ?? null;
  };
  return {
    async list({ limit }) {
      const rows: TestSet[] = [];
      for (const versions of store.values()) {
        const l = latest(versions);
        if (l !== null) rows.push(l);
      }
      return { data: rows.slice(0, limit) };
    },
    async get({ testSetId }) {
      const versions = store.get(testSetId);
      if (versions === undefined) return null;
      return latest(versions);
    },
    async getVersion({ testSetId, version }) {
      return store.get(testSetId)?.get(version) ?? null;
    },
    async headExists({ testSetId }) {
      return store.has(testSetId);
    },
    async listVersions({ testSetId, limit }) {
      const versions = store.get(testSetId);
      if (versions === undefined) return { data: [] };
      return { data: [...versions.values()].slice(0, limit) };
    },
    async publish({ testSet }) {
      let versions = store.get(testSet.id);
      if (versions === undefined) {
        versions = new Map();
        store.set(testSet.id, versions);
      }
      if (versions.has(testSet.version)) {
        return { kind: 'already-registered', testSetId: testSet.id, version: testSet.version };
      }
      versions.set(testSet.version, testSet);
      return { kind: 'ok', testSetId: testSet.id, version: testSet.version };
    },
    async unregister({ testSetId, version }) {
      const versions = store.get(testSetId);
      if (versions === undefined) return { unregistered: false };
      const removed = versions.delete(version);
      if (versions.size === 0) store.delete(testSetId);
      return { unregistered: removed };
    },
    async reinstateVersion({ testSetId, version }) {
      return { kind: 'not-found', testSetId, version };
    },
  };
}

async function seedTestSet(
  registry: TestSetRegistryBinding,
  overrides: Partial<TestSet> & {
    id: string;
    kind: TestSetKind;
    spec: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const testSet: TestSet = {
    id: overrides.id,
    tenantId,
    version: overrides.version ?? '1.0.0',
    kind: overrides.kind,
    ...(overrides.description !== undefined && { description: overrides.description }),
    spec: overrides.spec,
  };
  await registry.publish({
    tenantId,
    projectId: TEST_PROJECT_ID as never,
    testSet,
    enqueueTuples: () => [],
  });
}

// ---------- deterministic subject + grader ----------

/**
 * Stub subject invoker — returns `expected` if it's present on the
 * case metadata so the reference accuracy dispatcher can exercise
 * the pass path; toggles a `mismatch` field on other cases so we
 * can exercise the fail path.
 */
function makeStubSubject(behavior: 'pass' | 'fail' | 'mixed' = 'pass'): TestRunSubjectInvoker {
  let calls = 0;
  return {
    async invoke({ input }): Promise<{ output: unknown }> {
      const call = calls++;
      if (behavior === 'fail') return { output: 'wrong' };
      if (behavior === 'mixed') {
        return {
          output: call % 2 === 0 ? ((input as { expected?: unknown }).expected ?? 'ok') : 'wrong',
        };
      }
      // pass — return whatever the case marks as the expected.
      if (typeof input === 'object' && input !== null && 'expected' in input) {
        return { output: (input as { expected: unknown }).expected };
      }
      return { output: 'ok' };
    },
  };
}

/** Deterministic grader — passes when actualOutput === expected. */
const eqGrader: EvalGrader = {
  id: 'stub:eq',
  async grade({ actualOutput, expected }) {
    const pass = deepEqual(actualOutput, expected);
    return {
      pass,
      score: pass ? 1 : 0,
      ...(pass === false && { reason: 'output does not match expected' }),
      metadata: { graderId: 'stub:eq' },
    };
  },
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- wire-up helper ----------

interface AppSetup {
  readonly app: ReturnType<typeof createApp>;
  readonly registry: TestSetRegistryBinding;
  readonly binding: TestRunBinding;
}

function makeApp(
  options: {
    behavior?: 'pass' | 'fail' | 'mixed';
    kinds?: readonly TestSetKind[];
    subject?: TestRunSubjectInvoker;
    /** With authorization on: what the caller holds, as `<action> <type>:<id>`. */
    grants?: readonly string[];
    projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;
    referenceScope?: ReferenceScopeBinding;
  } = {},
): AppSetup {
  const registry = makeInMemoryRegistry();
  const subject = options.subject ?? makeStubSubject(options.behavior ?? 'pass');
  const kinds = options.kinds ?? ['accuracy'];
  const dispatchers: Partial<Record<TestSetKind, ReturnType<typeof createAccuracyDispatcher>>> = {};
  if (kinds.includes('accuracy')) {
    dispatchers.accuracy = createAccuracyDispatcher({ grader: eqGrader });
  }
  const binding = createInProcessTestRunBinding({
    testSetRegistry: registry,
    subject,
    dispatchers,
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: options.grants === undefined ? resolveToken : resolveUserToken,
    runHandler,
    testSetRegistry: registry,
    testRunBinding: binding,
    ...(options.grants !== undefined && { authz: grantsAuthz(options.grants) }),
    ...(options.projectSuspended !== undefined && { projectSuspended: options.projectSuspended }),
    ...(options.referenceScope !== undefined && { referenceScope: options.referenceScope }),
  });
  return { app, registry, binding };
}

/** An authorizer that allows exactly `grants` (`<action> <type>:<id>`). */
function grantsAuthz(grants: readonly string[]) {
  const decision = (action: Action, resource: ResourceRef): Decision => {
    const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
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
  };
  return {
    fgaApiUrl: 'http://fga.invalid',
    authzCheckBinding: {
      check: async (_p, action, resource) => decision(action, resource),
      checkBatch: async (_p, action, resources) => resources.map((r) => decision(action, r)),
    } satisfies AuthzCheckBinding,
  };
}

async function waitForRun(
  binding: TestRunBinding,
  testRunId: string,
  predicate: (r: TestRun) => boolean,
  timeoutMs = 2_000,
): Promise<TestRun> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await binding.get({ tenantId, testRunId: testRunId as never });
    if (run !== null && predicate(run)) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  const final = await binding.get({ tenantId, testRunId: testRunId as never });
  throw new Error(
    `Timed out waiting for run ${testRunId}; last status=${final?.status ?? 'null'} result=${JSON.stringify(final?.result)}`,
  );
}

// ---------- tests ----------

const accuracySpec: Readonly<Record<string, unknown>> = {
  cases: [
    { id: 'c1', input: { prompt: 'a', expected: 'A' }, expected: 'A' },
    { id: 'c2', input: { prompt: 'b', expected: 'B' }, expected: 'B' },
  ],
  grader: { adapterId: 'stub:eq' },
};

describe('API — test-runs start: who may start one', () => {
  // An editor of the project (write on it, execute on the agent and on the
  // test set) runs the test set: the improve loop's step. Starting a run
  // doesn't change the test set, so it doesn't need admin on it.
  const editor = (testSetId: string) => [
    `read test_set:${testSetId}`,
    `execute test_set:${testSetId}`,
    `read project:${TEST_PROJECT_ID}`,
    `write project:${TEST_PROJECT_ID}`,
    'execute agent:acme.drafting',
  ];
  const start = (
    app: ReturnType<typeof createApp>,
    testSetId: string,
    projectId: string = TEST_PROJECT_ID,
  ) =>
    app.request(`/v1/test-sets/${testSetId}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        agentRef: { agentId: 'acme.drafting', version: '1.0.0' },
      }),
    });

  test('a project editor starts a run: 201, without admin on the test set', async () => {
    const { app, registry } = makeApp({ grants: editor('acme.editor-run') });
    await seedTestSet(registry, { id: 'acme.editor-run', kind: 'accuracy', spec: accuracySpec });
    const res = await start(app, 'acme.editor-run');
    expect(res.status, await res.text()).toBe(201);
  });

  test("without execute on the agent: 403, the route's own check", async () => {
    const grants = editor('acme.no-exec').filter((g) => !g.startsWith('execute agent'));
    const { app, registry } = makeApp({ grants });
    await seedTestSet(registry, { id: 'acme.no-exec', kind: 'accuracy', spec: accuracySpec });
    const res = await start(app, 'acme.no-exec');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('agent:acme.drafting');
  });

  test('a viewer (read only) is refused: 403', async () => {
    const grants = ['read test_set:acme.viewer', `read project:${TEST_PROJECT_ID}`];
    const { app, registry } = makeApp({ grants });
    await seedTestSet(registry, { id: 'acme.viewer', kind: 'accuracy', spec: accuracySpec });
    const res = await start(app, 'acme.viewer');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('test_set:acme.viewer');
  });

  test("a test set's viewer who edits another project can't run it into that one: 403", async () => {
    // Read on the test set (a viewer of its project), write on project B and
    // execute on the agent: the run would land in B, so it needs `execute`
    // on the test set itself.
    const other = randomUUID();
    const grants = [
      'read test_set:acme.cross',
      `read project:${TEST_PROJECT_ID}`,
      `read project:${other}`,
      `write project:${other}`,
      'execute agent:acme.drafting',
    ];
    const { app, registry } = makeApp({ grants });
    await seedTestSet(registry, { id: 'acme.cross', kind: 'accuracy', spec: accuracySpec });
    const res = await start(app, 'acme.cross', other);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('test_set:acme.cross');
  });

  test('only `POST /:testSetId/runs` itself skips the test set admin check', async () => {
    const { app, registry } = makeApp({ grants: editor('acme.deeper') });
    await seedTestSet(registry, { id: 'acme.deeper', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/test-sets/acme.deeper/versions/acme.deeper/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('"action":"admin"');
  });

  test('changing the test set still needs admin on it: an editor unregistering a version gets 403', async () => {
    const { app, registry } = makeApp({ grants: editor('acme.editor-unreg') });
    await seedTestSet(registry, { id: 'acme.editor-unreg', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/test-sets/acme.editor-unreg/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('"action":"admin"');
  });
});

describe("API — test-runs start: an agent's own test set is frozen first, and that version runs", () => {
  const AGENT = 'acme.drafting';
  const OWN = `agent.${AGENT}.${TEST_PROJECT_ID}`;

  /**
   * The app with a freeze that answers `cases` cases at 1.0.3 (`freeze:
   * false`: none wired), and a run binding that records each start. A run
   * of the agent's own set answers at once; another runs as today.
   */
  function ownSetApp(
    options: {
      cases?: number;
      freeze?: false;
      grants?: readonly string[];
      correctionRegistry?: CorrectionRegistryBinding;
    } = {},
  ) {
    const { registry, binding: inner } = makeApp();
    const freezes: FreezeTestSetInput[] = [];
    const starts: Parameters<TestRunBinding['start']>[0][] = [];
    const testSetFreeze: TestSetFreezeBinding = {
      async freezeTestSet(input): Promise<FrozenTestSet> {
        freezes.push(input);
        const n = options.cases ?? 2;
        return {
          testSetId: OWN,
          testSetVersion: '1.0.3',
          cases: Array.from({ length: n }, (_, i) => ({
            caseId: `case-${i}`,
            correctionId: `case-${i}`,
          })),
        } as FrozenTestSet;
      },
    };
    const binding: TestRunBinding = {
      ...inner,
      async start(input) {
        starts.push(input);
        return input.testSetId === OWN
          ? { kind: 'ok', testRunId: 'run-own' as never }
          : inner.start(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: options.grants === undefined ? resolveToken : resolveUserToken,
      runHandler,
      testSetRegistry: registry,
      testRunBinding: binding,
      ...(options.freeze !== false && { testSetFreeze }),
      ...(options.grants !== undefined && { authz: grantsAuthz(options.grants) }),
      ...(options.correctionRegistry !== undefined && {
        correctionRegistry: options.correctionRegistry,
      }),
    });
    return { app, registry, freezes, starts };
  }

  const start = (
    app: ReturnType<typeof createApp>,
    testSetId: string,
    body: Record<string, unknown> = {},
  ) =>
    app.request(`/v1/test-sets/${testSetId}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: AGENT, version: '1.0.0' },
        ...body,
      }),
    });

  test('it freezes the set as it is now, and runs that version, recorded as testSetVersion', async () => {
    const { app, freezes, starts } = ownSetApp();
    const res = await start(app, OWN);
    expect(res.status, await res.text()).toBe(201);
    expect(freezes).toEqual([{ tenantId, agentId: AGENT, projectId: TEST_PROJECT_ID }]);
    expect(starts).toMatchObject([
      {
        testSetId: OWN,
        testSetVersion: '1.0.3',
        agentRef: { agentId: AGENT, version: '1.0.0' },
      },
    ]);
  });

  test("another agent's or project's own set, or a flow: 400 bad-input, and nothing is frozen", async () => {
    const { app, freezes, starts } = ownSetApp();
    const otherProject = `agent.${AGENT}.${randomUUID()}`;
    const answers = [
      await start(app, otherProject),
      await start(app, `agent.acme.other.${TEST_PROJECT_ID}`),
      await start(app, OWN, {
        agentRef: undefined,
        flowRef: { flowId: 'acme.flow', version: '1.0.0' },
      }),
    ];
    const bodies = await Promise.all(
      answers.map(async (r) => ({
        status: r.status,
        ...((await r.json()) as { error: { code: string; message: string } }).error,
      })),
    );
    expect(bodies.map((b) => [b.status, b.code])).toEqual([
      [400, 'bad-input'],
      [400, 'bad-input'],
      [400, 'bad-input'],
    ]);
    expect(bodies[0]?.message).toBe(
      `"${otherProject}" is an agent's own test set, and this run's agent and project have "${OWN}"`,
    );
    expect(bodies[2]?.message).toBe(
      `"${OWN}" is an agent's own test set: run it with \`agentRef\`, for its agent in its project`,
    );
    expect(freezes).toEqual([]);
    expect(starts).toEqual([]);
  });

  test("a runtime that doesn't freeze: 501, as a suggested change's check answers", async () => {
    const { app, starts } = ownSetApp({ freeze: false });
    const res = await start(app, OWN);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('suggested-change-check-unsupported');
    expect(starts).toEqual([]);
  });

  test("nothing to freeze: 409 in the check's words, and no run", async () => {
    const { app, starts } = ownSetApp({ cases: 0 });
    const res = await start(app, OWN);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({
      code: 'suggested-change-nothing-to-check',
      message: `Project ${TEST_PROJECT_ID} has no corrections of ${AGENT} to check a change on: correct some of its conversations first`,
    });
    expect(starts).toEqual([]);
  });

  test('with corrections, their cases are read first: none freezes nothing (409), and one freezes and runs', async () => {
    const cases = { data: [] as { id: string }[] };
    const correctionRegistry = {
      listCases: async () => ({ data: cases.data, hasMore: false }),
    } as unknown as CorrectionRegistryBinding;
    const { app, freezes, starts } = ownSetApp({ correctionRegistry });
    const none = await start(app, OWN);
    expect(none.status).toBe(409);
    const body = (await none.json()) as { error: { code: string } };
    expect(body.error.code).toBe('suggested-change-nothing-to-check');
    expect(freezes).toEqual([]);
    expect(starts).toEqual([]);

    cases.data = [{ id: 'case-0' }];
    const one = await start(app, OWN);
    expect(one.status, await one.text()).toBe(201);
    expect(freezes).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  test('another test set runs its latest version, as today, with nothing frozen', async () => {
    const { app, registry, freezes, starts } = ownSetApp();
    await seedTestSet(registry, { id: 'acme.by-hand', kind: 'accuracy', spec: accuracySpec });
    const res = await start(app, 'acme.by-hand');
    expect(res.status, await res.text()).toBe(201);
    expect(freezes).toEqual([]);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.testSetVersion).toBeUndefined();
  });

  test('who may: write on the project and running the agent, with no right on the set before its first freeze', async () => {
    const grants = [`read project:${TEST_PROJECT_ID}`, `write project:${TEST_PROJECT_ID}`];
    const allowed = ownSetApp({ grants: [...grants, `execute agent:${AGENT}`] });
    const ran = await start(allowed.app, OWN);
    expect(ran.status, await ran.text()).toBe(201);
    const refused = ownSetApp({ grants });
    expect((await start(refused.app, OWN)).status).toBe(403);
    expect(refused.freezes).toEqual([]);
    const noWrite = ownSetApp({
      grants: [`read project:${TEST_PROJECT_ID}`, `execute agent:${AGENT}`],
    });
    expect((await start(noWrite.app, OWN)).status).toBe(403);
    expect(noWrite.freezes).toEqual([]);
  });
});

describe('API — test-runs start (accuracy happy path)', () => {
  test('POST /v1/test-sets/:testSetId/runs → 201, testRunId; run completes with aggregate result', async () => {
    const { app, registry, binding } = makeApp({ behavior: 'pass' });
    await seedTestSet(registry, { id: 'acme.accuracy', kind: 'accuracy', spec: accuracySpec });

    const res = await app.request('/v1/test-sets/acme.accuracy/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting', version: '1.0.0' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { testRunId: string };
    expect(body.testRunId).toMatch(/^[0-9a-f-]{36}$/);

    const final = await waitForRun(binding, body.testRunId, (r) => r.status === 'completed');
    expect(final.status).toBe('completed');
    expect(final.testSetId).toBe('acme.accuracy');
    expect(final.testSetVersion).toBe('1.0.0');
    expect(final.kind).toBe('accuracy');
    expect(final.agentRef?.agentId).toBe('acme.drafting');
    const result = final.result as {
      passCount: number;
      totalCount: number;
      meanScore: number;
      perCase: unknown[];
    };
    expect(result.passCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.meanScore).toBe(1);
    expect(result.perCase).toHaveLength(2);
  });

  test('accuracy run with mixed outputs → completed with partial pass', async () => {
    const { app, registry, binding } = makeApp({ behavior: 'mixed' });
    await seedTestSet(registry, { id: 'acme.acc-mixed', kind: 'accuracy', spec: accuracySpec });

    const res = await app.request('/v1/test-sets/acme.acc-mixed/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { testRunId: string };
    const final = await waitForRun(binding, body.testRunId, (r) => r.status === 'completed');
    const result = final.result as { passCount: number; totalCount: number };
    expect(result.passCount).toBe(1);
    expect(result.totalCount).toBe(2);
  });
});

describe("API — test-runs start: the version it runs must be the project's to reach", () => {
  /** Reaches every item but `unreached` (`<kind>:<id>@<version>`, `@` alone for the item by its id); records each question. */
  const reach = (
    unreached: readonly string[],
    asked: ItemReference[] = [],
  ): ReferenceScopeBinding => ({
    async reachable({ ref }) {
      asked.push(ref);
      return !unreached.includes(`${ref.kind}:${ref.id}@${ref.version ?? ''}`);
    },
  });
  const UNREACHED = [
    'agent:acme.drafting@1.1.0',
    'flow:acme.triage@2.0.0',
    'agent:acme.elsewhere@',
    'tool:acme.offsite@',
  ];
  /** A subject that counts its cases, so a refused start is seen to run none. */
  const counting = () => {
    const calls = { n: 0 };
    const subject: TestRunSubjectInvoker = {
      async invoke({ input }) {
        calls.n += 1;
        return { output: (input as { expected: unknown }).expected };
      },
    };
    return { calls, subject };
  };
  const start = (app: AppSetup['app'], body: Record<string, unknown>) =>
    app.request('/v1/test-sets/acme.reach/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, ...body }),
    });
  const refusal = async (res: Response) =>
    (
      (await res.json()) as {
        error: {
          code: string;
          message: string;
          details?: { issues?: Record<string, unknown>[] };
        };
      }
    ).error;

  test.each([
    [
      'an agent',
      { agentRef: { agentId: 'acme.drafting', version: '1.0.0' } },
      'agent',
      'acme.drafting',
      '1.0.0',
    ],
    [
      'a flow',
      { flowRef: { flowId: 'acme.triage', version: '1.0.0' } },
      'flow',
      'acme.triage',
      '1.0.0',
    ],
  ] as const)(
    '%s at a version the project reaches starts: 201, asked at that version',
    async (_, body, kind, id, version) => {
      const asked: ItemReference[] = [];
      const { app, registry } = makeApp({ referenceScope: reach(UNREACHED, asked) });
      await seedTestSet(registry, { id: 'acme.reach', kind: 'accuracy', spec: accuracySpec });
      const res = await start(app, body);
      expect(res.status).toBe(201);
      expect(asked.filter((r) => r.kind === kind)).toStrictEqual([{ kind, id, version }]);
    },
  );

  test.each([
    [
      'an agent',
      { agentRef: { agentId: 'acme.drafting', version: '1.1.0' } },
      '/agentRef/agentId',
      'agent',
      'acme.drafting',
      'agent "acme.drafting" 1.1.0',
    ],
    [
      'a flow',
      { flowRef: { flowId: 'acme.triage', version: '2.0.0' } },
      '/flowRef/flowId',
      'flow',
      'acme.triage',
      'flow "acme.triage" 2.0.0',
    ],
  ] as const)(
    "%s at a version the project doesn't reach is refused at the start: 400 reference-out-of-scope, naming the version, and no case runs",
    async (_, body, path, kind, id, named) => {
      const { calls, subject } = counting();
      const { app, registry, binding } = makeApp({ subject, referenceScope: reach(UNREACHED) });
      await seedTestSet(registry, { id: 'acme.reach', kind: 'accuracy', spec: accuracySpec });
      const res = await start(app, body);
      expect(res.status).toBe(400);
      const error = await refusal(res);
      expect(error.code).toBe('reference-out-of-scope');
      expect(error.message).toBe(
        `This project can't reference ${named}: it isn't a version this project runs (not registered in this project, its org or the tenant, nor deployed to it)`,
      );
      expect(error.details?.issues).toEqual([
        {
          path,
          kind,
          id,
          message: `${named} isn't a version this project runs (not registered in this project, its org or the tenant, nor deployed to it)`,
        },
      ]);
      expect(calls.n).toBe(0);
      expect((await binding.list({ tenantId, limit: 10 })).data).toEqual([]);
    },
  );

  test('with no version, the item is asked about by its id, as before: reached, it starts; not, the refusal names no version', async () => {
    const asked: ItemReference[] = [];
    const { app, registry } = makeApp({ referenceScope: reach(UNREACHED, asked) });
    await seedTestSet(registry, { id: 'acme.reach', kind: 'accuracy', spec: accuracySpec });
    expect((await start(app, { agentRef: { agentId: 'acme.drafting' } })).status).toBe(201);
    expect(asked.filter((r) => r.kind === 'agent')).toStrictEqual([
      { kind: 'agent', id: 'acme.drafting' },
    ]);
    const error = await refusal(await start(app, { agentRef: { agentId: 'acme.elsewhere' } }));
    expect(error.code).toBe('reference-out-of-scope');
    expect(error.message).toBe(
      `This project can't reference agent "acme.elsewhere": it isn't registered in this project, its org or the tenant`,
    );
  });

  describe("a flow candidate's versions", () => {
    const flowRef = { flowId: 'acme.triage', version: '1.0.0' };

    test("an agent at a version the project doesn't reach is refused at its own path, naming the version, and no case runs", async () => {
      const { calls, subject } = counting();
      const { app, registry, binding } = makeApp({ subject, referenceScope: reach(UNREACHED) });
      await seedTestSet(registry, { id: 'acme.reach', kind: 'accuracy', spec: accuracySpec });
      const res = await start(app, { flowRef, versions: { agents: { 'acme.drafting': '1.1.0' } } });
      expect(res.status).toBe(400);
      const error = await refusal(res);
      expect(error.code).toBe('reference-out-of-scope');
      expect(error.message).toBe(
        `This project can't reference agent "acme.drafting" 1.1.0: it isn't a version this project runs (not registered in this project, its org or the tenant, nor deployed to it)`,
      );
      expect(error.details?.issues).toEqual([
        {
          path: '/versions/agents/acme.drafting',
          kind: 'agent',
          id: 'acme.drafting',
          message: `agent "acme.drafting" 1.1.0 isn't a version this project runs (not registered in this project, its org or the tenant, nor deployed to it)`,
        },
      ]);
      expect(calls.n).toBe(0);
      expect((await binding.list({ tenantId, limit: 10 })).data).toEqual([]);
    });

    test('the same agent at a version the project does reach starts: 201, asked at that version', async () => {
      const asked: ItemReference[] = [];
      const { app, registry } = makeApp({ referenceScope: reach(UNREACHED, asked) });
      await seedTestSet(registry, { id: 'acme.reach', kind: 'accuracy', spec: accuracySpec });
      const res = await start(app, { flowRef, versions: { agents: { 'acme.drafting': '1.0.0' } } });
      expect(res.status).toBe(201);
      expect(asked.filter((r) => r.kind === 'agent')).toStrictEqual([
        { kind: 'agent', id: 'acme.drafting', version: '1.0.0' },
      ]);
    });

    test('a tool is asked about by its id: reached, it starts; not, it is refused at its own path, with no version named', async () => {
      const asked: ItemReference[] = [];
      const { app, registry } = makeApp({ referenceScope: reach(UNREACHED, asked) });
      await seedTestSet(registry, { id: 'acme.reach', kind: 'accuracy', spec: accuracySpec });
      const res = await start(app, { flowRef, versions: { tools: { 'acme.lookup': '2.0.0' } } });
      expect(res.status).toBe(201);
      expect(asked.filter((r) => r.kind === 'tool')).toStrictEqual([
        { kind: 'tool', id: 'acme.lookup' },
      ]);
      const error = await refusal(
        await start(app, { flowRef, versions: { tools: { 'acme.offsite': '2.0.0' } } }),
      );
      expect(error.code).toBe('reference-out-of-scope');
      expect(error.details?.issues).toEqual([
        {
          path: '/versions/tools/acme.offsite',
          kind: 'tool',
          id: 'acme.offsite',
          message: `tool "acme.offsite" isn't registered in this project, its org or the tenant`,
        },
      ]);
    });

    test('each refused entry is named at its own path, beside the flow', async () => {
      const { app, registry } = makeApp({ referenceScope: reach(UNREACHED) });
      await seedTestSet(registry, { id: 'acme.reach', kind: 'accuracy', spec: accuracySpec });
      const error = await refusal(
        await start(app, {
          flowRef: { flowId: 'acme.triage', version: '2.0.0' },
          versions: {
            agents: { 'acme.drafting': '1.1.0', 'acme.desk': '1.0.0' },
            tools: { 'acme.offsite': '2.0.0', 'acme.lookup': '2.0.0' },
          },
        }),
      );
      expect(error.code).toBe('reference-out-of-scope');
      expect(error.message).toBe(
        `This project can't reference 3 of the items named (flow "acme.triage" 2.0.0, agent "acme.drafting" 1.1.0, tool "acme.offsite"): none is registered in this project, its org or the tenant, and no version named is deployed to it`,
      );
      expect(error.details?.issues?.map((i) => i.path)).toEqual([
        '/flowRef/flowId',
        '/versions/agents/acme.drafting',
        '/versions/tools/acme.offsite',
      ]);
    });
  });
});

describe('API — test-runs and a suspended project', () => {
  const threeCases: Readonly<Record<string, unknown>> = {
    ...accuracySpec,
    cases: [
      ...(accuracySpec.cases as unknown[]),
      { id: 'c3', input: { prompt: 'c', expected: 'C' }, expected: 'C' },
    ],
  };
  const start = (app: AppSetup['app'], testSetId: string) =>
    app.request(`/v1/test-sets/${testSetId}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting', version: '1.0.0' },
      }),
    });
  /** The second case's start is refused (`refused`), the others answer what they expect. */
  const refusingSecond = (refused: TestRunSubjectInvokeOutcome) => {
    const calls = { n: 0 };
    const subject: TestRunSubjectInvoker = {
      async invoke({ input }) {
        calls.n += 1;
        if (calls.n === 2) return refused;
        return { output: (input as { expected: unknown }).expected };
      },
    };
    return { calls, subject };
  };

  test('no run starts in it: 409 project-suspended, and nothing runs; restored, it starts', async () => {
    let suspended = true;
    const asked: string[] = [];
    const { calls, subject } = refusingSecond({ output: 'unused' });
    const { app, registry } = makeApp({
      subject,
      projectSuspended: async (_tenantId, projectId) => {
        asked.push(projectId as unknown as string);
        return suspended;
      },
    });
    await seedTestSet(registry, { id: 'acme.suspended', kind: 'accuracy', spec: accuracySpec });
    const refused = await start(app, 'acme.suspended');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'project-suspended',
    );
    expect(asked).toEqual([TEST_PROJECT_ID]);
    expect(calls.n).toBe(0);
    suspended = false;
    expect((await start(app, 'acme.suspended')).status).toBe(201);
  });

  test('a case it refuses to start stops the run there: cancelled, with the reason, and the cases before it', async () => {
    const { calls, subject } = refusingSecond({
      halt: { reason: 'project-suspended', message: 'The project is suspended' },
    });
    const { app, registry, binding } = makeApp({ subject });
    await seedTestSet(registry, { id: 'acme.halted', kind: 'accuracy', spec: threeCases });
    const res = await start(app, 'acme.halted');
    const { testRunId } = (await res.json()) as { testRunId: string };
    const final = await waitForRun(binding, testRunId, (r) => r.status === 'cancelled');
    expect(final.cancelReason).toBe('project-suspended');
    expect(final.error).toBeUndefined();
    expect(calls.n).toBe(2);
    expect(final.result).toMatchObject({ passCount: 1, totalCount: 3, cancelled: true });
    expect((final.result as { perCase: unknown[] }).perCase).toHaveLength(1);
    const read = await app.request(`/v1/test-runs/${testRunId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await read.json()).toMatchObject({
      status: 'cancelled',
      cancelReason: 'project-suspended',
    });
  });

  test("a case's error isn't a halt: the run goes on to the end", async () => {
    const { calls, subject } = refusingSecond({ error: 'pack-suspended: the pack is suspended' });
    const { app, registry, binding } = makeApp({ subject });
    await seedTestSet(registry, { id: 'acme.errored', kind: 'accuracy', spec: threeCases });
    const res = await start(app, 'acme.errored');
    const { testRunId } = (await res.json()) as { testRunId: string };
    const final = await waitForRun(binding, testRunId, (r) => r.status === 'completed');
    expect(final.cancelReason).toBeUndefined();
    expect(calls.n).toBe(3);
    expect(final.result).toMatchObject({ passCount: 2, totalCount: 3 });
  });
});

describe('API — test-runs start (dryRun preview)', () => {
  test('dryRun: true returns preview envelope without invoking subject', async () => {
    let subjectCalls = 0;
    const trackingSubject: TestRunSubjectInvoker = {
      async invoke() {
        subjectCalls += 1;
        return { output: 'never called' };
      },
    };
    const { app, registry, binding } = makeApp({ subject: trackingSubject });
    await seedTestSet(registry, { id: 'acme.dryrun', kind: 'accuracy', spec: accuracySpec });

    const res = await app.request('/v1/test-sets/acme.dryrun/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'a' },
        dryRun: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { testRunId: string };
    const final = await waitForRun(binding, body.testRunId, (r) => r.status === 'completed');
    expect(final.dryRun).toBe(true);
    const result = final.result as { dryRun: boolean; totalCount: number; preview: unknown[] };
    expect(result.dryRun).toBe(true);
    expect(result.totalCount).toBe(2);
    expect(result.preview).toHaveLength(1);
    expect(subjectCalls).toBe(0);
  });
});

describe('API — test-runs start validation', () => {
  test('unknown test set → 404 test-set-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-sets/nope/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, agentRef: { agentId: 'a' } }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test-set-not-found');
  });

  test('both agentRef + flowRef → 400 bad-input', async () => {
    const { app, registry } = makeApp();
    await seedTestSet(registry, { id: 'acme.acc', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/test-sets/acme.acc/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'a' },
        flowRef: { flowId: 'g' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toContain('exactly one');
  });

  test('neither agentRef nor flowRef → 400 bad-input', async () => {
    const { app, registry } = makeApp();
    await seedTestSet(registry, { id: 'acme.acc', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/test-sets/acme.acc/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test("a `correlationId` starting `pin:` or `latest:` → 400 bad-input: they're the runs Kindgi starts itself", async () => {
    const { app, registry } = makeApp();
    await seedTestSet(registry, { id: 'acme.acc', kind: 'accuracy', spec: accuracySpec });
    for (const correlationId of ['pin:pc-1', 'latest:acme.desk:p-1']) {
      const res = await app.request('/v1/test-sets/acme.acc/runs', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: TEST_PROJECT_ID,
          agentRef: { agentId: 'a' },
          correlationId,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('bad-input');
      expect(body.error.message).toContain('may not start with `pin:` or `latest:`');
    }
  });

  test('malformed JSON body → 400 bad-input', async () => {
    const { app, registry } = makeApp();
    await seedTestSet(registry, { id: 'acme.acc', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/test-sets/acme.acc/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('empty accuracy spec.cases → 400 dispatcher-input-invalid', async () => {
    const { app, registry } = makeApp();
    await seedTestSet(registry, { id: 'acme.empty', kind: 'accuracy', spec: { cases: [] } });
    const res = await app.request('/v1/test-sets/acme.empty/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, agentRef: { agentId: 'a' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('dispatcher-input-invalid');
  });
});

describe('API — test-runs start: kind-not-yet-dispatchable', () => {
  const otherKinds: readonly TestSetKind[] = [
    'pairwise',
    'regression',
    'human-review',
    'benchmark',
    'custom',
  ];
  for (const kind of otherKinds) {
    test(`kind "${kind}" without dispatcher → 422 dispatcher-not-registered`, async () => {
      const { app, registry } = makeApp({ kinds: ['accuracy'] });
      await seedTestSet(registry, {
        id: `acme.${kind}`,
        kind,
        spec: { cases: [{ input: 'x', expected: 'x' }] },
      });
      const res = await app.request(`/v1/test-sets/acme.${kind}/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: TEST_PROJECT_ID, agentRef: { agentId: 'a' } }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('dispatcher-not-registered');
    });
  }
});

describe('API — test-runs idempotency', () => {
  test('same Idempotency-Key replays original 201 + testRunId', async () => {
    const { app, registry } = makeApp();
    await seedTestSet(registry, { id: 'acme.idem', kind: 'accuracy', spec: accuracySpec });
    const key = randomUUID();
    const body = JSON.stringify({
      projectId: TEST_PROJECT_ID,
      agentRef: { agentId: 'acme.drafting' },
    });
    const first = await app.request('/v1/test-sets/acme.idem/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { testRunId: string };

    const second = await app.request('/v1/test-sets/acme.idem/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body,
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const secondBody = (await second.json()) as { testRunId: string };
    expect(secondBody.testRunId).toBe(firstBody.testRunId);
  });
});

describe('API — test-runs list + filter', () => {
  test('list happy path + testSetId filter + status filter matrix', async () => {
    const { app, registry, binding } = makeApp();
    await seedTestSet(registry, { id: 'a.one', kind: 'accuracy', spec: accuracySpec });
    await seedTestSet(registry, { id: 'a.two', kind: 'accuracy', spec: accuracySpec });

    const startBody = JSON.stringify({
      projectId: TEST_PROJECT_ID,
      agentRef: { agentId: 'acme.drafting' },
    });
    const r1 = await app.request('/v1/test-sets/a.one/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: startBody,
    });
    const { testRunId: id1 } = (await r1.json()) as { testRunId: string };
    const r2 = await app.request('/v1/test-sets/a.two/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: startBody,
    });
    const { testRunId: id2 } = (await r2.json()) as { testRunId: string };
    await waitForRun(binding, id1, (r) => r.status === 'completed');
    await waitForRun(binding, id2, (r) => r.status === 'completed');

    const all = await app.request('/v1/test-runs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const allBody = (await all.json()) as { data: TestRun[]; hasMore: boolean };
    const ids = new Set(allBody.data.map((r) => r.testRunId as unknown as string));
    expect(ids.has(id1)).toBe(true);
    expect(ids.has(id2)).toBe(true);

    const filtered = await app.request('/v1/test-runs?testSetId=a.one', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const filteredBody = (await filtered.json()) as { data: TestRun[] };
    expect(filteredBody.data.map((r) => r.testSetId)).toEqual(['a.one']);

    const status = await app.request('/v1/test-runs?status=completed', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(status.status).toBe(200);

    const bad = await app.request('/v1/test-runs?status=not-a-status', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe('bad-input');
  });
});

describe('API — test-runs get', () => {
  test('GET /v1/test-runs/:testRunId returns the run row', async () => {
    const { app, registry, binding } = makeApp();
    await seedTestSet(registry, { id: 'acme.get', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/test-sets/acme.get/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { testRunId } = (await start.json()) as { testRunId: string };
    await waitForRun(binding, testRunId, (r) => r.status === 'completed');

    const res = await app.request(`/v1/test-runs/${testRunId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      testRunId: string;
      testSetId: string;
      status: TestRunStatus;
    };
    expect(body.testRunId).toBe(testRunId);
    expect(body.testSetId).toBe('acme.get');
    expect(body.status).toBe('completed');
  });

  test('GET /v1/test-runs/:testRunId unknown → 404 test-run-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-runs/00000000-0000-0000-0000-000000000000', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test-run-not-found');
  });
});

describe('API — test-runs cancel', () => {
  test('cancel roundtrip on a slow run flips status to cancelled', async () => {
    let released: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      released = res;
    });
    const slowSubject: TestRunSubjectInvoker = {
      async invoke({ input, abortSignal }) {
        // First case: block until either aborted or explicitly released.
        await Promise.race([
          gate,
          new Promise<void>((resolve) =>
            abortSignal.addEventListener('abort', () => resolve(), { once: true }),
          ),
        ]);
        return { output: (input as { expected?: unknown }).expected };
      },
    };
    const { app, registry, binding } = makeApp({ subject: slowSubject });
    await seedTestSet(registry, { id: 'acme.slow', kind: 'accuracy', spec: accuracySpec });

    const start = await app.request('/v1/test-sets/acme.slow/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { testRunId } = (await start.json()) as { testRunId: string };
    await waitForRun(binding, testRunId, (r) => r.status === 'running');

    const cancel = await app.request(`/v1/test-runs/${testRunId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancel.status).toBe(200);
    const cancelBody = (await cancel.json()) as { status: TestRunStatus };
    expect(cancelBody.status).toBe('cancelled');

    released?.();
    const final = await waitForRun(binding, testRunId, (r) => r.status === 'cancelled');
    expect(final.status).toBe('cancelled');
  });

  test('cancel already-terminal → 409 test-run-already-terminal', async () => {
    const { app, registry, binding } = makeApp();
    await seedTestSet(registry, { id: 'acme.term', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/test-sets/acme.term/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { testRunId } = (await start.json()) as { testRunId: string };
    await waitForRun(binding, testRunId, (r) => r.status === 'completed');

    const cancel = await app.request(`/v1/test-runs/${testRunId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancel.status).toBe(409);
    const body = (await cancel.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test-run-already-terminal');
  });

  test('cancel unknown testRunId → 404 test-run-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-runs/00000000-0000-0000-0000-000000000000/cancel', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test-run-not-found');
  });
});

describe('API — test-runs SSE events', () => {
  async function readAllSse(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  }

  function parseFrames(raw: string): Array<{ id?: string; event?: string; data?: unknown }> {
    const frames: Array<{ id?: string; event?: string; data?: unknown }> = [];
    for (const chunk of raw.split('\n\n')) {
      if (chunk.trim() === '') continue;
      const frame: { id?: string; event?: string; data?: unknown } = {};
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length > 0) {
        try {
          frame.data = JSON.parse(dataLines.join('\n'));
        } catch {
          frame.data = dataLines.join('\n');
        }
      }
      frames.push(frame);
    }
    return frames;
  }

  test('per-case + terminal frames emitted in order', async () => {
    const { app, registry, binding } = makeApp({ behavior: 'pass' });
    await seedTestSet(registry, { id: 'acme.sse', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/test-sets/acme.sse/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { testRunId } = (await start.json()) as { testRunId: string };
    await waitForRun(binding, testRunId, (r) => r.status === 'completed');

    const stream = await app.request(`/v1/test-runs/${testRunId}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('Content-Type')).toContain('text/event-stream');
    const raw = await readAllSse(stream.body as ReadableStream<Uint8Array>);
    const frames = parseFrames(raw);
    const events = frames.map((f) => f.event);
    expect(events).toEqual([
      'test-run.case-completed',
      'test-run.case-completed',
      'test-run.completed',
    ]);
    const terminal = frames[frames.length - 1]?.data as {
      status: TestRunStatus;
      result: { passCount: number; totalCount: number };
    };
    expect(terminal.status).toBe('completed');
    expect(terminal.result.passCount).toBe(2);
  });

  test('unknown testRunId → 404 test-run-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/test-runs/00000000-0000-0000-0000-000000000000/events', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('test-run-not-found');
  });

  /** A run that stays running, one case in; each read of it counted. */
  function runningRunApp() {
    const counted = { reads: 0 };
    const testRunId = randomUUID();
    const running = {
      testRunId,
      tenantId,
      testSetId: 'acme.sse',
      testSetVersion: '1.0.0',
      kind: 'accuracy',
      status: 'running',
      dryRun: false,
      startedAt: '2026-10-16T00:00:00.000Z',
      result: { perCase: [{ pass: true }] },
    } as unknown as TestRun;
    let hold: { entered: () => void; released: Promise<void> } | undefined;
    /** Holds each read of the run until `release`; `waiting` resolves once one waits. */
    const holdReads = () => {
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((entered) => {
        hold = { entered, released };
      });
      return { waiting, release };
    };
    const testRunBinding = {
      get: async ({ testRunId: id }: { testRunId: string }) => {
        counted.reads += 1;
        if (hold !== undefined) {
          hold.entered();
          await hold.released;
        }
        return id === testRunId ? running : null;
      },
    } as unknown as TestRunBinding;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      testRunBinding,
    });
    const call = (
      method: 'GET' | 'HEAD',
      { id = testRunId, signal }: { id?: string; signal?: AbortSignal } = {},
    ) =>
      app.request(`/v1/test-runs/${id}/events`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, 'x-request-id': 'req-events' },
        ...(signal !== undefined && { signal }),
      });
    return { call, counted, holdReads };
  }

  test('a reader that cancels: no read of the run and no timer after the cancel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { call, counted } = runningRunApp();
      const res = await call('GET');
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: test-run.case-completed');
      await vi.advanceTimersByTimeAsync(1_000);
      const polled = counted.reads;
      // It polls while it's read: the route's read, the stream's first, then one every 100 ms.
      expect(polled).toBeGreaterThan(2);
      await reader.cancel();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(counted.reads).toBe(polled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a HEAD answers the stream's status and headers and starts none of its work", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { call, counted } = runningRunApp();
      const head = await call('HEAD');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // The route's one read, to find the run; no poll and no timer: the stream never started.
      expect(counted.reads).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(head.body).toBeNull();
      const get = await call('GET');
      await get.body?.cancel();
      expect([head.status, get.status]).toEqual([200, 200]);
      // Each request answers its own span; every other header is the same.
      const { traceresponse: headSpan, ...headHeaders } = Object.fromEntries(head.headers);
      const { traceresponse: getSpan, ...getHeaders } = Object.fromEntries(get.headers);
      expect([headSpan, getSpan]).toEqual([expect.any(String), expect.any(String)]);
      expect(headHeaders).toEqual(getHeaders);
      expect(headHeaders['content-type']).toBe('text/event-stream; charset=utf-8');
      // A run that isn't there: the GET's 404.
      const absent = randomUUID();
      const [headMissing, getMissing] = [
        await call('HEAD', { id: absent }),
        await call('GET', { id: absent }),
      ];
      expect([headMissing.status, getMissing.status, headMissing.body]).toEqual([404, 404, null]);
      expect(Object.fromEntries(headMissing.headers)).toEqual({
        ...Object.fromEntries(getMissing.headers),
        traceresponse: expect.any(String),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a client that leaves during the read check: the stream never starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { call, counted, holdReads } = runningRunApp();
      const { waiting, release } = holdReads();
      const client = new AbortController();
      const answered = call('GET', { signal: client.signal });
      await waiting;
      client.abort();
      release();
      const res = await answered;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // The route's one read, to find the run; no poll and no timer. The body is never touched.
      expect(counted.reads).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect([res.status, res.body]).toEqual([200, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a client that leaves after the answer, its body never read: the polls stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { call, counted } = runningRunApp();
      const client = new AbortController();
      const res = await call('GET', { signal: client.signal });
      expect(res.status).toBe(200);
      await vi.advanceTimersByTimeAsync(1_000);
      const polled = counted.reads;
      // It polls while the client is there: the route's read, the stream's first, then one every 100 ms.
      expect(polled).toBeGreaterThan(2);
      client.abort();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(counted.reads).toBe(polled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('API — test-runs surface unmounted when no binding supplied', () => {
  test('no `testRunBinding` → routes 404 at Hono level', async () => {
    const registry = makeInMemoryRegistry();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      testSetRegistry: registry,
    });
    await seedTestSet(registry, { id: 'a.one', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/test-sets/a.one/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentRef: { agentId: 'a' } }),
    });
    expect(start.status).toBe(404);

    const list = await app.request('/v1/test-runs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(list.status).toBe(404);
  });
});

// Silences a spurious "unused" warning for the Cursor type import when
// the type only participates via structural equality in test bindings.
void 0 as unknown as Cursor;
void 0 as unknown as TestRunPage;

// -------------------- scope filter --------------------

describe('API — test-runs scope filter', () => {
  function makeSpy() {
    const { registry, binding: inner } = makeApp();
    let lastListInput: Parameters<TestRunBinding['list']>[0] | null = null;
    const spy: TestRunBinding = {
      ...inner,
      async list(input) {
        lastListInput = input;
        return inner.list(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      testSetRegistry: registry,
      testRunBinding: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/test-runs?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/test-runs?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/test-runs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/test-runs?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});
