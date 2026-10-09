// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  EvalGrader,
  EvalKind,
  EvalRun,
  EvalRunBinding,
  EvalRunPage,
  EvalRunStatus,
  EvalSubjectInvoker,
  EvalSuite,
  EvalSuiteRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { createAccuracyDispatcher, createInProcessEvalRunBinding } from '../src/index.js';

/**
 * Eval-run route tests. The registry + run binding are
 * both caller-plugged. The registry uses the same in-memory pattern
 * as `eval-suites-routes.test.ts`; the run binding uses the reference
 * `createInProcessEvalRunBinding` with a synthetic subject invoker
 * and a deterministic grader. Covers start (accuracy happy path,
 * dryRun, unknown suite, both/neither ref, idempotency replay,
 * dispatcher-not-registered for the other five kinds), list (filter
 * matrix), get, cancel (roundtrip + already-terminal), SSE (event
 * ordering + terminal), unmounted-route.
 */

const tenantId = randomUUID() as TenantId;
// The eval-run start body carries `projectId` (content-scope anchor).
// The in-process reference binding doesn't validate against a real
// `projects` table (no storage) — any non-empty string satisfies the
// route's parser; the storage adapter (the Postgres eval-run registry adapter, `eval-run-registry-
// postgres`) is the one that surfaces `project-not-found` via FK.
const TEST_PROJECT_ID = randomUUID();
const TOKEN = 'eval-runs-token-abc';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  return null;
};

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

// ---------- in-memory registry (mirrors eval-suites test) ----------

function makeInMemoryRegistry(): EvalSuiteRegistryBinding {
  const store = new Map<string, Map<string, EvalSuite>>();
  const latest = (versions: Map<string, EvalSuite>): EvalSuite | null => {
    const arr = [...versions.values()];
    return arr[arr.length - 1] ?? null;
  };
  return {
    async list({ limit }) {
      const rows: EvalSuite[] = [];
      for (const versions of store.values()) {
        const l = latest(versions);
        if (l !== null) rows.push(l);
      }
      return { data: rows.slice(0, limit) };
    },
    async get({ suiteId }) {
      const versions = store.get(suiteId);
      if (versions === undefined) return null;
      return latest(versions);
    },
    async getVersion({ suiteId, version }) {
      return store.get(suiteId)?.get(version) ?? null;
    },
    async headExists({ suiteId }) {
      return store.has(suiteId);
    },
    async listVersions({ suiteId, limit }) {
      const versions = store.get(suiteId);
      if (versions === undefined) return { data: [] };
      return { data: [...versions.values()].slice(0, limit) };
    },
    async publish({ suite }) {
      let versions = store.get(suite.id);
      if (versions === undefined) {
        versions = new Map();
        store.set(suite.id, versions);
      }
      if (versions.has(suite.version)) {
        return { kind: 'already-registered', suiteId: suite.id, version: suite.version };
      }
      versions.set(suite.version, suite);
      return { kind: 'ok', suiteId: suite.id, version: suite.version };
    },
    async unregister({ suiteId, version }) {
      const versions = store.get(suiteId);
      if (versions === undefined) return { unregistered: false };
      const removed = versions.delete(version);
      if (versions.size === 0) store.delete(suiteId);
      return { unregistered: removed };
    },
    async reinstateVersion({ suiteId, version }) {
      return { kind: 'not-found', suiteId, version };
    },
  };
}

async function seedSuite(
  registry: EvalSuiteRegistryBinding,
  overrides: Partial<EvalSuite> & {
    id: string;
    kind: EvalKind;
    spec: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const suite: EvalSuite = {
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
    suite,
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
function makeStubSubject(behavior: 'pass' | 'fail' | 'mixed' = 'pass'): EvalSubjectInvoker {
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
  readonly registry: EvalSuiteRegistryBinding;
  readonly binding: EvalRunBinding;
}

function makeApp(
  options: {
    behavior?: 'pass' | 'fail' | 'mixed';
    kinds?: readonly EvalKind[];
    subject?: EvalSubjectInvoker;
  } = {},
): AppSetup {
  const registry = makeInMemoryRegistry();
  const subject = options.subject ?? makeStubSubject(options.behavior ?? 'pass');
  const kinds = options.kinds ?? ['accuracy'];
  const dispatchers: Partial<Record<EvalKind, ReturnType<typeof createAccuracyDispatcher>>> = {};
  if (kinds.includes('accuracy')) {
    dispatchers.accuracy = createAccuracyDispatcher({ grader: eqGrader });
  }
  const binding = createInProcessEvalRunBinding({
    suiteRegistry: registry,
    subject,
    dispatchers,
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    evalSuiteRegistry: registry,
    evalRunBinding: binding,
  });
  return { app, registry, binding };
}

async function waitForRun(
  binding: EvalRunBinding,
  runId: string,
  predicate: (r: EvalRun) => boolean,
  timeoutMs = 2_000,
): Promise<EvalRun> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await binding.get({ tenantId, runId: runId as never });
    if (run !== null && predicate(run)) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  const final = await binding.get({ tenantId, runId: runId as never });
  throw new Error(
    `Timed out waiting for run ${runId}; last status=${final?.status ?? 'null'} result=${JSON.stringify(final?.result)}`,
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

describe('API — eval-runs start (accuracy happy path)', () => {
  test('POST /v1/eval-suites/:suiteId/runs → 201, runId; run completes with aggregate result', async () => {
    const { app, registry, binding } = makeApp({ behavior: 'pass' });
    await seedSuite(registry, { id: 'acme.accuracy', kind: 'accuracy', spec: accuracySpec });

    const res = await app.request('/v1/eval-suites/acme.accuracy/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting', version: '1.0.0' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);

    const final = await waitForRun(binding, body.runId, (r) => r.status === 'completed');
    expect(final.status).toBe('completed');
    expect(final.suiteId).toBe('acme.accuracy');
    expect(final.suiteVersion).toBe('1.0.0');
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
    await seedSuite(registry, { id: 'acme.acc-mixed', kind: 'accuracy', spec: accuracySpec });

    const res = await app.request('/v1/eval-suites/acme.acc-mixed/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    const final = await waitForRun(binding, body.runId, (r) => r.status === 'completed');
    const result = final.result as { passCount: number; totalCount: number };
    expect(result.passCount).toBe(1);
    expect(result.totalCount).toBe(2);
  });
});

describe('API — eval-runs start (dryRun preview)', () => {
  test('dryRun: true returns preview envelope without invoking subject', async () => {
    let subjectCalls = 0;
    const trackingSubject: EvalSubjectInvoker = {
      async invoke() {
        subjectCalls += 1;
        return { output: 'never called' };
      },
    };
    const { app, registry, binding } = makeApp({ subject: trackingSubject });
    await seedSuite(registry, { id: 'acme.dryrun', kind: 'accuracy', spec: accuracySpec });

    const res = await app.request('/v1/eval-suites/acme.dryrun/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'a' },
        dryRun: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    const final = await waitForRun(binding, body.runId, (r) => r.status === 'completed');
    expect(final.dryRun).toBe(true);
    const result = final.result as { dryRun: boolean; totalCount: number; preview: unknown[] };
    expect(result.dryRun).toBe(true);
    expect(result.totalCount).toBe(2);
    expect(result.preview).toHaveLength(1);
    expect(subjectCalls).toBe(0);
  });
});

describe('API — eval-runs start validation', () => {
  test('unknown suite → 404 eval-suite-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-suites/nope/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, agentRef: { agentId: 'a' } }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('eval-suite-not-found');
  });

  test('both agentRef + flowRef → 400 bad-input', async () => {
    const { app, registry } = makeApp();
    await seedSuite(registry, { id: 'acme.acc', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/eval-suites/acme.acc/runs', {
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
    await seedSuite(registry, { id: 'acme.acc', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/eval-suites/acme.acc/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('malformed JSON body → 400 bad-input', async () => {
    const { app, registry } = makeApp();
    await seedSuite(registry, { id: 'acme.acc', kind: 'accuracy', spec: accuracySpec });
    const res = await app.request('/v1/eval-suites/acme.acc/runs', {
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
    await seedSuite(registry, { id: 'acme.empty', kind: 'accuracy', spec: { cases: [] } });
    const res = await app.request('/v1/eval-suites/acme.empty/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, agentRef: { agentId: 'a' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('dispatcher-input-invalid');
  });
});

describe('API — eval-runs start: kind-not-yet-dispatchable', () => {
  const otherKinds: readonly EvalKind[] = [
    'pairwise',
    'regression',
    'human-review',
    'benchmark',
    'custom',
  ];
  for (const kind of otherKinds) {
    test(`kind "${kind}" without dispatcher → 422 dispatcher-not-registered`, async () => {
      const { app, registry } = makeApp({ kinds: ['accuracy'] });
      await seedSuite(registry, {
        id: `acme.${kind}`,
        kind,
        spec: { cases: [{ input: 'x', expected: 'x' }] },
      });
      const res = await app.request(`/v1/eval-suites/acme.${kind}/runs`, {
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

describe('API — eval-runs idempotency', () => {
  test('same Idempotency-Key replays original 201 + runId', async () => {
    const { app, registry } = makeApp();
    await seedSuite(registry, { id: 'acme.idem', kind: 'accuracy', spec: accuracySpec });
    const key = randomUUID();
    const body = JSON.stringify({
      projectId: TEST_PROJECT_ID,
      agentRef: { agentId: 'acme.drafting' },
    });
    const first = await app.request('/v1/eval-suites/acme.idem/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { runId: string };

    const second = await app.request('/v1/eval-suites/acme.idem/runs', {
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
    const secondBody = (await second.json()) as { runId: string };
    expect(secondBody.runId).toBe(firstBody.runId);
  });
});

describe('API — eval-runs list + filter', () => {
  test('list happy path + suiteId filter + status filter matrix', async () => {
    const { app, registry, binding } = makeApp();
    await seedSuite(registry, { id: 'a.one', kind: 'accuracy', spec: accuracySpec });
    await seedSuite(registry, { id: 'a.two', kind: 'accuracy', spec: accuracySpec });

    const startBody = JSON.stringify({
      projectId: TEST_PROJECT_ID,
      agentRef: { agentId: 'acme.drafting' },
    });
    const r1 = await app.request('/v1/eval-suites/a.one/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: startBody,
    });
    const { runId: id1 } = (await r1.json()) as { runId: string };
    const r2 = await app.request('/v1/eval-suites/a.two/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: startBody,
    });
    const { runId: id2 } = (await r2.json()) as { runId: string };
    await waitForRun(binding, id1, (r) => r.status === 'completed');
    await waitForRun(binding, id2, (r) => r.status === 'completed');

    const all = await app.request('/v1/eval-runs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const allBody = (await all.json()) as { data: EvalRun[]; hasMore: boolean };
    const ids = new Set(allBody.data.map((r) => r.runId as unknown as string));
    expect(ids.has(id1)).toBe(true);
    expect(ids.has(id2)).toBe(true);

    const filtered = await app.request('/v1/eval-runs?suiteId=a.one', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const filteredBody = (await filtered.json()) as { data: EvalRun[] };
    expect(filteredBody.data.map((r) => r.suiteId)).toEqual(['a.one']);

    const status = await app.request('/v1/eval-runs?status=completed', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(status.status).toBe(200);

    const bad = await app.request('/v1/eval-runs?status=not-a-status', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe('bad-input');
  });
});

describe('API — eval-runs get', () => {
  test('GET /v1/eval-runs/:runId returns the run row', async () => {
    const { app, registry, binding } = makeApp();
    await seedSuite(registry, { id: 'acme.get', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/eval-suites/acme.get/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { runId } = (await start.json()) as { runId: string };
    await waitForRun(binding, runId, (r) => r.status === 'completed');

    const res = await app.request(`/v1/eval-runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; suiteId: string; status: EvalRunStatus };
    expect(body.runId).toBe(runId);
    expect(body.suiteId).toBe('acme.get');
    expect(body.status).toBe('completed');
  });

  test('GET /v1/eval-runs/:runId unknown → 404 eval-run-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-runs/00000000-0000-0000-0000-000000000000', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('eval-run-not-found');
  });
});

describe('API — eval-runs cancel', () => {
  test('cancel roundtrip on a slow run flips status to cancelled', async () => {
    let released: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      released = res;
    });
    const slowSubject: EvalSubjectInvoker = {
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
    await seedSuite(registry, { id: 'acme.slow', kind: 'accuracy', spec: accuracySpec });

    const start = await app.request('/v1/eval-suites/acme.slow/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { runId } = (await start.json()) as { runId: string };
    await waitForRun(binding, runId, (r) => r.status === 'running');

    const cancel = await app.request(`/v1/eval-runs/${runId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancel.status).toBe(200);
    const cancelBody = (await cancel.json()) as { status: EvalRunStatus };
    expect(cancelBody.status).toBe('cancelled');

    released?.();
    const final = await waitForRun(binding, runId, (r) => r.status === 'cancelled');
    expect(final.status).toBe('cancelled');
  });

  test('cancel already-terminal → 409 eval-run-already-terminal', async () => {
    const { app, registry, binding } = makeApp();
    await seedSuite(registry, { id: 'acme.term', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/eval-suites/acme.term/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { runId } = (await start.json()) as { runId: string };
    await waitForRun(binding, runId, (r) => r.status === 'completed');

    const cancel = await app.request(`/v1/eval-runs/${runId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancel.status).toBe(409);
    const body = (await cancel.json()) as { error: { code: string } };
    expect(body.error.code).toBe('eval-run-already-terminal');
  });

  test('cancel unknown runId → 404 eval-run-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-runs/00000000-0000-0000-0000-000000000000/cancel', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('eval-run-not-found');
  });
});

describe('API — eval-runs SSE events', () => {
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
    await seedSuite(registry, { id: 'acme.sse', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/eval-suites/acme.sse/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: TEST_PROJECT_ID,
        agentRef: { agentId: 'acme.drafting' },
      }),
    });
    const { runId } = (await start.json()) as { runId: string };
    await waitForRun(binding, runId, (r) => r.status === 'completed');

    const stream = await app.request(`/v1/eval-runs/${runId}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('Content-Type')).toContain('text/event-stream');
    const raw = await readAllSse(stream.body as ReadableStream<Uint8Array>);
    const frames = parseFrames(raw);
    const events = frames.map((f) => f.event);
    expect(events).toEqual([
      'eval-run.case-completed',
      'eval-run.case-completed',
      'eval-run.completed',
    ]);
    const terminal = frames[frames.length - 1]?.data as {
      status: EvalRunStatus;
      result: { passCount: number; totalCount: number };
    };
    expect(terminal.status).toBe('completed');
    expect(terminal.result.passCount).toBe(2);
  });

  test('unknown runId → 404 eval-run-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/eval-runs/00000000-0000-0000-0000-000000000000/events', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('eval-run-not-found');
  });
});

describe('API — eval-runs surface unmounted when no binding supplied', () => {
  test('no `evalRunBinding` → routes 404 at Hono level', async () => {
    const registry = makeInMemoryRegistry();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      evalSuiteRegistry: registry,
    });
    await seedSuite(registry, { id: 'a.one', kind: 'accuracy', spec: accuracySpec });
    const start = await app.request('/v1/eval-suites/a.one/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentRef: { agentId: 'a' } }),
    });
    expect(start.status).toBe(404);

    const list = await app.request('/v1/eval-runs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(list.status).toBe(404);
  });
});

// Silences a spurious "unused" warning for the Cursor type import when
// the type only participates via structural equality in test bindings.
void 0 as unknown as Cursor;
void 0 as unknown as EvalRunPage;

// -------------------- scope filter --------------------

describe('API — eval-runs scope filter', () => {
  function makeSpy() {
    const { registry, binding: inner } = makeApp();
    let lastListInput: Parameters<EvalRunBinding['list']>[0] | null = null;
    const spy: EvalRunBinding = {
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
      evalSuiteRegistry: registry,
      evalRunBinding: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/eval-runs?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/eval-runs?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/eval-runs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/eval-runs?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});
