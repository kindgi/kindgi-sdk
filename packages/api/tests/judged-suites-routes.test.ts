// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test sets built from judgments: `POST /v1/eval-suites/:id/versions/from-judgments`
 * and `GET /v1/eval-suites/:id/versions/:version/cases`.
 */

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, test } from 'vitest';

import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  EvalSuite,
  EvalSuiteRegistryBinding,
  JudgmentRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';
import { inMemoryJudgments } from './support/in-memory-judgments.js';

const tenantId = randomUUID() as TenantId;
const project = randomUUID() as ProjectId;
const TOKEN = 'judged-suites-token';

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

const runHandler = {} as RunHandlerBinding;

/** An eval-suite registry that only knows how to publish; a suite stays in its first project. */
function suiteRegistry(): EvalSuiteRegistryBinding & { readonly published: EvalSuite[] } {
  const published: EvalSuite[] = [];
  const owners = new Map<string, string>();
  return {
    published,
    async publish({ suite, projectId }: { suite: EvalSuite; projectId: string }) {
      const owner = owners.get(suite.id);
      if (owner !== undefined && owner !== projectId) {
        return {
          kind: 'project-mismatch',
          suiteId: suite.id,
          version: suite.version,
          projectId: owner,
        };
      }
      owners.set(suite.id, projectId);
      if (published.some((s) => s.id === suite.id && s.version === suite.version)) {
        return { kind: 'already-registered', suiteId: suite.id, version: suite.version };
      }
      published.push(suite);
      return { kind: 'ok', suiteId: suite.id, version: suite.version };
    },
  } as unknown as EvalSuiteRegistryBinding & { readonly published: EvalSuite[] };
}

type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ readonly status: number; readonly body: Record<string, any> }>;

interface Harness {
  readonly call: Call;
  readonly judgments: JudgmentRegistryBinding;
  readonly suites: ReturnType<typeof suiteRegistry>;
  readonly expertId: string;
}

const subject = (version = '2.0.0') => ({ kind: 'agent' as const, id: 'acme.matcher', version });

async function seed(judgments: JudgmentRegistryBinding): Promise<string> {
  const created = await judgments.createClass({
    tenantId,
    scope: { kind: 'tenant' },
    name: 'expert',
    weight: 3,
  });
  if (created.kind !== 'created') throw new Error('class not created');
  const expertId = created.judgeClass.id;
  const record = (
    runId: string,
    run: { version?: string; input: unknown; output: unknown; context?: object },
    item: { key: string; rank?: number },
    verdict: 'yes' | 'no',
    by: string,
    extra: { judgeClassId?: string; reason?: string } = {},
  ) =>
    judgments.record({
      tenantId,
      projectId: project,
      runId,
      run: {
        subject: subject(run.version),
        input: run.input,
        output: run.output,
        ...(run.context !== undefined && { context: run.context }),
      },
      item,
      verdict,
      assertedBy: { kind: 'user', id: by },
      ...extra,
    });

  // run-1 (oldest): c2 is judged before c1, but c1 is rank 0.
  const one = {
    input: { query: 'acme' },
    output: { matches: [{ id: 'c1' }, { id: 'c2' }] },
    context: { history: [{ sequence: 0 }], retrieved: ['Acme Corp'] },
  };
  await record('run-1', one, { key: 'c2', rank: 1 }, 'no', 'u1');
  await record('run-1', one, { key: 'c1', rank: 0 }, 'yes', 'u1', {
    judgeClassId: expertId,
    reason: 'right',
  });
  await record('run-1', one, { key: 'c1', rank: 0 }, 'no', 'u2', { reason: 'wrong city' });
  // run-2: one unclassified judgment.
  await record(
    'run-2',
    { input: { query: 'beta' }, output: { matches: [] } },
    { key: 'x' },
    'yes',
    'u1',
  );
  // run-3 (newest): another agent version.
  await record(
    'run-3',
    { version: '3.0.0', input: { query: 'gamma' }, output: { matches: [] } },
    { key: 'y' },
    'no',
    'u3',
    { judgeClassId: expertId },
  );
  return expertId;
}

async function harness(): Promise<Harness> {
  const stubs = createStubAppBindings();
  const judgments = inMemoryJudgments();
  const suites = suiteRegistry();
  const expertId = await seed(judgments);
  return { ...makeCall(stubs, judgments, suites), judgments, suites, expertId };
}

function makeCall(
  stubs: ReturnType<typeof createStubAppBindings>,
  judgments: JudgmentRegistryBinding,
  suites: EvalSuiteRegistryBinding,
): { readonly call: Call } {
  const app = createApp({
    ...stubs,
    resolveToken,
    runHandler,
    judgmentRegistry: judgments,
    evalSuiteRegistry: suites,
    evalCaseStore: inMemoryCaseStore(),
  });
  const call: Call = async (method, path, body) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call };
}

const BUILD = '/v1/eval-suites/acme.matches/versions/from-judgments';
const base = { version: '1.0.0', projectId: project, agentId: 'acme.matcher' };

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('POST /v1/eval-suites/:id/versions/from-judgments', () => {
  test('builds cases with the items summed, ranked, and the run copied', async () => {
    const res = await h.call('POST', BUILD, { ...base, description: 'First set' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      suiteId: 'acme.matches',
      version: '1.0.0',
      kind: 'judged',
      caseCount: 3,
      truncated: false,
    });
    expect(h.suites.published[0]).toMatchObject({
      id: 'acme.matches',
      version: '1.0.0',
      kind: 'judged',
      description: 'First set',
      spec: { source: 'judgments', caseCount: 3, truncated: false },
    });

    const cases = await h.call('GET', '/v1/eval-suites/acme.matches/versions/1.0.0/cases');
    expect(cases.status).toBe(200);
    // Newest judged run first.
    expect(cases.body.data.map((c: { caseId: string }) => c.caseId)).toEqual([
      'run-3',
      'run-2',
      'run-1',
    ]);
    const one = cases.body.data[2];
    expect(one).toMatchObject({
      caseId: 'run-1',
      subject: subject(),
      input: { query: 'acme' },
      output: { matches: [{ id: 'c1' }, { id: 'c2' }] },
      context: { history: [{ sequence: 0 }], retrieved: ['Acme Corp'] },
    });
    // Sorted by rank, though c2 was judged first.
    expect(one.items).toEqual([
      {
        key: 'c1',
        rank: 0,
        yes: 1,
        no: 1,
        yesWeight: 3,
        totalWeight: 4,
        restricted: { yesWeight: 0, totalWeight: 0 },
        // Newest first; a classified judgment's reason names its class.
        reasons: [
          { verdict: 'no', reason: 'wrong city' },
          { verdict: 'yes', reason: 'right', judgeClassId: h.expertId },
        ],
      },
      {
        key: 'c2',
        rank: 1,
        yes: 0,
        no: 1,
        yesWeight: 0,
        totalWeight: 1,
        restricted: { yesWeight: 0, totalWeight: 0 },
        reasons: [],
      },
    ]);
    // An unclassified judgment counts 1; a run without context has none.
    expect(cases.body.data[1].items).toEqual([
      {
        key: 'x',
        yes: 1,
        no: 0,
        yesWeight: 1,
        totalWeight: 1,
        restricted: { yesWeight: 0, totalWeight: 0 },
        reasons: [],
      },
    ]);
    expect(cases.body.data[1].context).toBeUndefined();
  });

  test('segments keep only runs started in that segment or below it: a judgment in globex never counts for acme', async () => {
    const at = (company: string, more: { key: string; value: string }[] = []) => [
      { key: 'company', value: company },
      ...more,
    ];
    const record = (runId: string, segments: { key: string; value: string }[] | undefined) =>
      h.judgments.record({
        tenantId,
        projectId: project,
        runId,
        run: {
          subject: subject(),
          input: { query: runId },
          output: { matches: [{ id: 'x' }] },
          ...(segments !== undefined && { segments }),
        },
        item: { key: 'x' },
        verdict: 'no',
        reason: `wrong for ${runId}`,
        assertedBy: { kind: 'user', id: 'u1' },
      });
    await record('acme-run', at('acme'));
    await record('acme-cfo-run', at('acme', [{ key: 'role', value: 'cfo' }]));
    await record('globex-run', at('globex'));
    await record('plain-run', []);
    const ids = async (version: string, segments: unknown) => {
      const res = await h.call('POST', BUILD, { ...base, version, segments });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const cases = await h.call('GET', `/v1/eval-suites/acme.matches/versions/${version}/cases`);
      return cases.body.data.map((c: { caseId: string }) => c.caseId).sort();
    };
    expect(await ids('2.0.0', at('acme'))).toEqual(['acme-cfo-run', 'acme-run']);
    expect(await ids('2.1.0', at('acme', [{ key: 'role', value: 'cfo' }]))).toEqual([
      'acme-cfo-run',
    ]);
    expect(await ids('2.2.0', at('globex'))).toEqual(['globex-run']);
    // Runs judged before segments were recorded (seed's run-1..3) and runs with none are in no segment.
    expect(await ids('2.3.0', at('initech'))).toEqual([]);
    // The test set says what it was narrowed to.
    expect(h.suites.published.find((s) => s.version === '2.0.0')?.spec).toMatchObject({
      query: { segments: at('acme') },
    });
    expect(
      (
        await h.call('POST', BUILD, {
          ...base,
          version: '3.0.0',
          segments: [{ key: 'Company', value: 'acme' }],
        })
      ).status,
    ).toBe(400);
  });

  test('agentVersion narrows to one version of the agent', async () => {
    const res = await h.call('POST', BUILD, { ...base, agentVersion: '3.0.0' });
    expect(res.body.caseCount).toBe(1);
  });

  test('minJudgments leaves out runs with fewer judgments', async () => {
    const res = await h.call('POST', BUILD, { ...base, minJudgments: 2 });
    expect(res.status).toBe(201);
    expect(res.body.caseCount).toBe(1);
    const cases = await h.call('GET', '/v1/eval-suites/acme.matches/versions/1.0.0/cases');
    expect(cases.body.data.map((c: { caseId: string }) => c.caseId)).toEqual(['run-1']);
  });

  test("judgeClassIds counts only those classes' judgments", async () => {
    const res = await h.call('POST', BUILD, { ...base, judgeClassIds: [h.expertId] });
    expect(res.body.caseCount).toBe(2);
    const cases = await h.call('GET', '/v1/eval-suites/acme.matches/versions/1.0.0/cases');
    const byId = new Map(cases.body.data.map((c: { caseId: string }) => [c.caseId, c]));
    // run-1 keeps the expert's judgment on c1 and drops the rest.
    expect((byId.get('run-1') as { items: unknown[] }).items).toEqual([
      {
        key: 'c1',
        rank: 0,
        yes: 1,
        no: 0,
        yesWeight: 3,
        totalWeight: 3,
        restricted: { yesWeight: 0, totalWeight: 0 },
        reasons: [{ verdict: 'yes', reason: 'right', judgeClassId: h.expertId }],
      },
    ]);
    expect(byId.has('run-2')).toBe(false);
  });

  test('a judgment recorded under a restricted class is counted apart too; restricting the class later changes nothing', async () => {
    // The expert's judgments on run-1 were recorded before the class was restricted.
    await h.judgments.updateClass({
      tenantId,
      judgeClassId: h.expertId,
      assertableBy: { minReviewerRole: 'senior' },
    });
    // One recorded under the restriction: the route marks it `restricted` once the judge meets it.
    await h.judgments.record({
      tenantId,
      projectId: project,
      runId: 'run-1',
      run: { subject: subject(), input: {}, output: {} },
      item: { key: 'c2', rank: 1 },
      verdict: 'yes',
      reason: 'the right firm',
      judgeClassId: h.expertId,
      restricted: true,
      assertedBy: { kind: 'user', id: 'senior-1' },
    });
    await h.call('POST', BUILD, base);
    const cases = await h.call('GET', '/v1/eval-suites/acme.matches/versions/1.0.0/cases');
    const run1 = cases.body.data.find((c: { caseId: string }) => c.caseId === 'run-1');
    // c1: the expert's yes (3) predates the restriction, so nothing on it is restricted.
    expect(run1.items[0]).toMatchObject({
      key: 'c1',
      yesWeight: 3,
      totalWeight: 4,
      restricted: { yesWeight: 0, totalWeight: 0 },
    });
    // c2: the senior expert's yes (3) is restricted; the unclassified no (1) isn't.
    expect(run1.items[1]).toMatchObject({
      key: 'c2',
      yesWeight: 3,
      totalWeight: 4,
      restricted: { yesWeight: 3, totalWeight: 3 },
    });
    // Its reason says it was restricted; the expert's earlier one on c1 doesn't.
    expect(run1.items[1].reasons).toContainEqual({
      verdict: 'yes',
      reason: 'the right firm',
      judgeClassId: h.expertId,
      restricted: true,
    });
    expect(run1.items[0].reasons).toContainEqual({
      verdict: 'yes',
      reason: 'right',
      judgeClassId: h.expertId,
    });
  });

  test('agentVersion without agentId: 400', async () => {
    const res = await h.call('POST', BUILD, {
      version: '1.0.0',
      projectId: project,
      flowId: 'acme.match',
      agentVersion: '2.0.0',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });

  test('neither agent nor flow: 400', async () => {
    const res = await h.call('POST', BUILD, { version: '1.0.0', projectId: project });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });

  test('a bad semver: 400', async () => {
    const res = await h.call('POST', BUILD, { ...base, version: 'v1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });

  test('the same version twice: 409', async () => {
    expect((await h.call('POST', BUILD, base)).status).toBe(201);
    const again = await h.call('POST', BUILD, base);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('eval-suite-already-registered');
  });

  test('a suite of another project: 409 eval-suite-project-mismatch, and nothing is built', async () => {
    expect((await h.call('POST', BUILD, base)).status).toBe(201);
    const elsewhere = { ...base, version: '2.0.0', projectId: randomUUID() };
    const res = await h.call('POST', BUILD, elsewhere);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('eval-suite-project-mismatch');
    expect(res.body.error.message).toContain(`belongs to project "${project}"`);
    expect(h.suites.published.map((s) => s.version)).toEqual(['1.0.0']);
  });

  test('a binding that cannot list judged runs: 501', async () => {
    const { listJudgedRuns: _unsupported, ...without } = h.judgments;
    const { call } = makeCall(createStubAppBindings(), without, h.suites);
    const res = await call('POST', BUILD, base);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('test-sets-not-supported');
    expect(h.suites.published).toHaveLength(0);
  });
});

describe('GET /v1/eval-suites/:id/versions/:version/cases', () => {
  test('pages with limit and cursor', async () => {
    await h.call('POST', BUILD, base);
    const path = '/v1/eval-suites/acme.matches/versions/1.0.0/cases';
    const first = await h.call('GET', `${path}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.data.map((c: { caseId: string }) => c.caseId)).toEqual(['run-3', 'run-2']);
    expect(first.body.hasMore).toBe(true);
    const second = await h.call('GET', `${path}?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data.map((c: { caseId: string }) => c.caseId)).toEqual(['run-1']);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.nextCursor).toBeUndefined();
  });

  test('a version with no cases is an empty page', async () => {
    const res = await h.call('GET', '/v1/eval-suites/acme.matches/versions/9.9.9/cases');
    expect(res.body).toEqual({ data: [], hasMore: false });
  });
});
