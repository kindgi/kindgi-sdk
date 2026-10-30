// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test sets built from corrections: `POST /v1/test-sets/:id/versions/from-corrections`
 * and `GET /v1/test-sets/:id/versions/:version/cases`.
 */

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, test } from 'vitest';

import { CORRECTION_ITEM, type ProjectId, type TenantId, type UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, sortAtSave } from '../src/index.js';
import type {
  CorrectionRecordInput,
  CorrectionRegistryBinding,
  RunHandlerBinding,
  TestSet,
  TestSetRegistryBinding,
  TokenResolver,
} from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';

const tenantId = randomUUID() as TenantId;
const project = randomUUID() as ProjectId;
const TOKEN = 'corrected-test-sets-token';

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

const runHandler = {} as RunHandlerBinding;

/** An test-set registry that only knows how to publish; a test set stays in its first project. */
function testSetRegistry(): TestSetRegistryBinding & { readonly published: TestSet[] } {
  const published: TestSet[] = [];
  const owners = new Map<string, string>();
  return {
    published,
    async publish({ testSet, projectId }: { testSet: TestSet; projectId: string }) {
      const owner = owners.get(testSet.id);
      if (owner !== undefined && owner !== projectId) {
        return {
          kind: 'project-mismatch',
          testSetId: testSet.id,
          version: testSet.version,
          projectId: owner,
        };
      }
      owners.set(testSet.id, projectId);
      if (published.some((s) => s.id === testSet.id && s.version === testSet.version)) {
        return { kind: 'already-registered', testSetId: testSet.id, version: testSet.version };
      }
      published.push(testSet);
      return { kind: 'ok', testSetId: testSet.id, version: testSet.version };
    },
  } as unknown as TestSetRegistryBinding & { readonly published: TestSet[] };
}

type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ readonly status: number; readonly body: Record<string, any> }>;

interface Harness {
  readonly call: Call;
  readonly corrections: CorrectionRegistryBinding;
  readonly testSets: ReturnType<typeof testSetRegistry>;
  readonly expertId: string;
}

const subject = (version = '2.0.0') => ({ kind: 'agent' as const, id: 'acme.matcher', version });

type Says = Pick<
  CorrectionRecordInput,
  'decisions' | 'shouldCall' | 'mustNotCall' | 'answer' | 'shouldSay' | 'why' | 'items'
>;

/** What a correction says, by whom, sorted at save as the route sorts it. */
const says = (by: string, fields: Says, expert = false) => ({
  ...fields,
  madeBy: { kind: 'user' as const, id: by },
  ...sortAtSave({ ...fields, expert }, { kind: 'user', id: by }, '2026-10-01T00:00:00.000Z'),
});

async function seed(corrections: CorrectionRegistryBinding): Promise<string> {
  const created = await corrections.createGroup({
    tenantId,
    scope: { kind: 'tenant' },
    name: 'expert',
    weight: 3,
  });
  if (created.kind !== 'created') throw new Error('group not created');
  const expertId = created.correctorGroup.id;
  const record = (
    runId: string,
    run: { version?: string; input: unknown; output: unknown; context?: object },
    by: string,
    fields: Says,
    extra: { correctorGroupId?: string } = {},
  ) =>
    corrections.record({
      tenantId,
      projectId: project,
      runId,
      run: {
        subject: subject(run.version),
        input: run.input,
        output: run.output,
        ...(run.context !== undefined && { context: run.context }),
      },
      ...says(by, fields),
      ...extra,
    });

  // run-1 (oldest): c2 is corrected before c1, but c1 is rank 0.
  const one = {
    input: { query: 'acme' },
    output: {
      appended: [{ role: 'agent', content: 'Acme Corp' }],
      matches: [{ id: 'c1' }, { id: 'c2' }],
    },
    context: { history: [{ sequence: 0 }], retrieved: ['Acme Corp'] },
  };
  await record('run-1', one, 'u4', { items: [{ key: 'c2', rank: 1, verdict: 'wrong' }] });
  await record(
    'run-1',
    one,
    'u1',
    { answer: 'right', why: 'right', items: [{ key: 'c1', rank: 0, verdict: 'right' }] },
    { correctorGroupId: expertId },
  );
  await record('run-1', one, 'u2', {
    answer: 'wrong',
    why: 'wrong city',
    items: [{ key: 'c1', rank: 0, verdict: 'wrong' }],
  });
  // run-2: one unclassified correction.
  await record('run-2', { input: { query: 'beta' }, output: { matches: [] } }, 'u1', {
    items: [{ key: 'x', verdict: 'right' }],
  });
  // run-3 (newest): another agent version.
  await record(
    'run-3',
    { version: '3.0.0', input: { query: 'gamma' }, output: { matches: [] } },
    'u3',
    { items: [{ key: 'y', verdict: 'wrong' }] },
    { correctorGroupId: expertId },
  );
  return expertId;
}

async function harness(): Promise<Harness> {
  const stubs = createStubAppBindings();
  const corrections = inMemoryCorrections();
  const testSets = testSetRegistry();
  const expertId = await seed(corrections);
  return { ...makeCall(stubs, corrections, testSets), corrections, testSets, expertId };
}

function makeCall(
  stubs: ReturnType<typeof createStubAppBindings>,
  corrections: CorrectionRegistryBinding,
  testSets: TestSetRegistryBinding,
): { readonly call: Call } {
  const app = createApp({
    ...stubs,
    resolveToken,
    runHandler,
    correctionRegistry: corrections,
    testSetRegistry: testSets,
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

const BUILD = '/v1/test-sets/acme.matches/versions/from-corrections';
const base = { version: '1.0.0', projectId: project, agentId: 'acme.matcher' };

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('POST /v1/test-sets/:id/versions/from-corrections', () => {
  test('builds cases with the items summed, ranked, and the run copied', async () => {
    const res = await h.call('POST', BUILD, { ...base, description: 'First set' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      testSetId: 'acme.matches',
      version: '1.0.0',
      kind: 'corrections',
      caseCount: 3,
      truncated: false,
    });
    expect(h.testSets.published[0]).toMatchObject({
      id: 'acme.matches',
      version: '1.0.0',
      kind: 'corrections',
      description: 'First set',
      spec: { source: 'corrections', caseCount: 3, truncated: false },
    });

    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases');
    expect(cases.status).toBe(200);
    // Newest corrected run first.
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
      output: {
        appended: [{ role: 'agent', content: 'Acme Corp' }],
        matches: [{ id: 'c1' }, { id: 'c2' }],
      },
      context: { history: [{ sequence: 0 }], retrieved: ['Acme Corp'] },
    });
    // Sorted by rank, though c2 was corrected first; the answer has no rank, so it's last.
    expect(one.items).toEqual([
      {
        key: 'c1',
        rank: 0,
        yes: 1,
        no: 1,
        yesWeight: 3,
        totalWeight: 4,
        expert: { yesWeight: 0, totalWeight: 0, correctionIds: [] },
        // Every correction summed into the item, newest first: u2's no, then the expert's yes.
        correctionIds: ['j-3', 'j-2'],
        reasons: [],
      },
      {
        key: 'c2',
        rank: 1,
        yes: 0,
        no: 1,
        yesWeight: 0,
        totalWeight: 1,
        expert: { yesWeight: 0, totalWeight: 0, correctionIds: [] },
        // A correction without a reason is named too.
        correctionIds: ['j-1'],
        reasons: [],
      },
      {
        // The answer sits at the turn's last agent message.
        key: 'answer',
        pointer: '/appended/0/content',
        yes: 1,
        no: 1,
        yesWeight: 3,
        totalWeight: 4,
        expert: { yesWeight: 0, totalWeight: 0, correctionIds: [] },
        correctionIds: ['j-3', 'j-2'],
        // Newest first; a grouped correction's reason names its group.
        reasons: [
          { verdict: 'no', reason: 'wrong city' },
          { verdict: 'yes', reason: 'right', correctorGroupId: h.expertId },
        ],
      },
    ]);
    // An unclassified correction counts 1; a run without context has none.
    expect(cases.body.data[1].items).toEqual([
      {
        key: 'x',
        yes: 1,
        no: 0,
        yesWeight: 1,
        totalWeight: 1,
        expert: { yesWeight: 0, totalWeight: 0, correctionIds: [] },
        correctionIds: ['j-4'],
        reasons: [],
      },
    ]);
    expect(cases.body.data[1].context).toBeUndefined();
  });

  test("a kept correction's expected decisions ride onto its case, with its corrector group and restriction", async () => {
    const corrected = await h.corrections.record({
      tenantId,
      projectId: project,
      runId: 'run-corr',
      run: { subject: subject(), input: { query: 'delta' }, output: { matches: [{ id: 'd1' }] } },
      ...says(
        'u5',
        {
          decisions: 'wrong',
          shouldCall: [{ tool: 'acme.refund', args: { amount: 25 } }],
          mustNotCall: ['acme.email'],
        },
        true,
      ),
      correctorGroupId: h.expertId,
      expert: true,
    });
    expect((await h.call('POST', BUILD, base)).status).toBe(201);

    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases');
    const built = cases.body.data.find((c: { caseId: string }) => c.caseId === 'run-corr');
    expect(built.corrections).toEqual([
      {
        correctionId: corrected.id,
        correctorGroupId: h.expertId,
        expert: true,
        calls: [{ tool: 'acme.refund', args: { amount: 25 } }],
        notCalled: ['acme.email'],
      },
    ]);
    // A run whose kept corrections carry no expected decisions has none.
    const plain = cases.body.data.find((c: { caseId: string }) => c.caseId === 'run-2');
    expect(plain.corrections).toBeUndefined();
  });

  test('a re-saved correction replaces the first, so its case carries one (counts once)', async () => {
    const recordAt = (amount: number) =>
      h.corrections.record({
        tenantId,
        projectId: project,
        runId: 'run-once',
        run: { subject: subject(), input: { query: 'omega' }, output: { matches: [{ id: 'o1' }] } },
        ...says('u6', {
          decisions: 'wrong',
          shouldCall: [{ tool: 'acme.refund', args: { amount } }],
        }),
        correctorGroupId: h.expertId,
      });
    await recordAt(25);
    await recordAt(40);
    expect((await h.call('POST', BUILD, base)).status).toBe(201);

    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases');
    const built = cases.body.data.find((c: { caseId: string }) => c.caseId === 'run-once');
    // The first was superseded, so only the second rides onto the case.
    expect(built.corrections).toHaveLength(1);
    expect(built.corrections[0]).toMatchObject({
      calls: [{ tool: 'acme.refund', args: { amount: 40 } }],
      notCalled: [],
    });
  });

  test("a correction's decisions and its own 'decision' item stay apart", async () => {
    // Decisions go on the reserved key, which is Kindgi's own, so a caller's
    // item named 'decision' never shares it: the expected calls ride on
    // `corrections`, and both verdicts ride on `items`, apart.
    await h.corrections.record({
      tenantId,
      projectId: project,
      runId: 'run-apart',
      run: { subject: subject(), input: { query: 'sigma' }, output: { decision: 'refund' } },
      ...says('u7', {
        decisions: 'wrong',
        shouldCall: [{ tool: 'acme.refund', args: { amount: 25 } }],
        items: [{ key: 'decision', pointer: '/decision', verdict: 'right' }],
      }),
      correctorGroupId: h.expertId,
    });
    expect((await h.call('POST', BUILD, base)).status).toBe(201);

    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases');
    const built = cases.body.data.find((c: { caseId: string }) => c.caseId === 'run-apart');
    expect(built.corrections).toHaveLength(1);
    expect(built.corrections[0]).toMatchObject({
      calls: [{ tool: 'acme.refund', args: { amount: 25 } }],
    });
    expect(built.items).toEqual([
      expect.objectContaining({ key: CORRECTION_ITEM.key, pointer: '', yes: 0, no: 1 }),
      expect.objectContaining({ key: 'decision', pointer: '/decision', yes: 1, no: 0 }),
    ]);
  });

  test('segments keep only runs started in that segment or below it: a correction in globex never counts for acme', async () => {
    const at = (company: string, more: { key: string; value: string }[] = []) => [
      { key: 'company', value: company },
      ...more,
    ];
    const record = (runId: string, segments: { key: string; value: string }[] | undefined) =>
      h.corrections.record({
        tenantId,
        projectId: project,
        runId,
        run: {
          subject: subject(),
          input: { query: runId },
          output: { matches: [{ id: 'x' }] },
          ...(segments !== undefined && { segments }),
        },
        ...says('u1', { why: `wrong for ${runId}`, items: [{ key: 'x', verdict: 'wrong' }] }),
      });
    await record('acme-run', at('acme'));
    await record('acme-cfo-run', at('acme', [{ key: 'role', value: 'cfo' }]));
    await record('globex-run', at('globex'));
    await record('plain-run', []);
    const ids = async (version: string, segments: unknown) => {
      const res = await h.call('POST', BUILD, { ...base, version, segments });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const cases = await h.call('GET', `/v1/test-sets/acme.matches/versions/${version}/cases`);
      return cases.body.data.map((c: { caseId: string }) => c.caseId).sort();
    };
    expect(await ids('2.0.0', at('acme'))).toEqual(['acme-cfo-run', 'acme-run']);
    expect(await ids('2.1.0', at('acme', [{ key: 'role', value: 'cfo' }]))).toEqual([
      'acme-cfo-run',
    ]);
    expect(await ids('2.2.0', at('globex'))).toEqual(['globex-run']);
    // Runs corrected before segments were recorded (seed's run-1..3) and runs with none are in no segment.
    expect(await ids('2.3.0', at('initech'))).toEqual([]);
    // The test set says what it was narrowed to.
    expect(h.testSets.published.find((s) => s.version === '2.0.0')?.spec).toMatchObject({
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

  test('minCorrections leaves out runs with fewer corrections', async () => {
    const res = await h.call('POST', BUILD, { ...base, minCorrections: 2 });
    expect(res.status).toBe(201);
    expect(res.body.caseCount).toBe(1);
    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases');
    expect(cases.body.data.map((c: { caseId: string }) => c.caseId)).toEqual(['run-1']);
  });

  test("correctorGroupIds counts only those groups' corrections", async () => {
    const res = await h.call('POST', BUILD, { ...base, correctorGroupIds: [h.expertId] });
    expect(res.body.caseCount).toBe(2);
    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases');
    const byId = new Map(cases.body.data.map((c: { caseId: string }) => [c.caseId, c]));
    // run-1 keeps the expert's correction (c1 and the answer) and drops the rest.
    const kept = {
      yes: 1,
      no: 0,
      yesWeight: 3,
      totalWeight: 3,
      expert: { yesWeight: 0, totalWeight: 0, correctionIds: [] },
      // Only the kept group's correction is named: u2's unclassified no isn't counted.
      correctionIds: ['j-2'],
    };
    expect((byId.get('run-1') as { items: unknown[] }).items).toEqual([
      { key: 'c1', rank: 0, ...kept, reasons: [] },
      {
        key: 'answer',
        pointer: '/appended/0/content',
        ...kept,
        reasons: [{ verdict: 'yes', reason: 'right', correctorGroupId: h.expertId }],
      },
    ]);
    expect(byId.has('run-2')).toBe(false);
  });

  test('a correction recorded under an expert group is counted apart too; restricting the group later changes nothing', async () => {
    // The expert's corrections on run-1 were recorded before the group was restricted.
    await h.corrections.updateGroup({
      tenantId,
      correctorGroupId: h.expertId,
      assertableBy: { minReviewerRole: 'senior' },
    });
    // One recorded under the restriction: the route marks it `expert` once whoever recorded it meets it.
    await h.corrections.record({
      tenantId,
      projectId: project,
      runId: 'run-1',
      run: { subject: subject(), input: {}, output: {} },
      ...says(
        'senior-1',
        {
          answer: 'right',
          why: 'the right firm',
          items: [{ key: 'c2', rank: 1, verdict: 'right' }],
        },
        true,
      ),
      correctorGroupId: h.expertId,
      expert: true,
    });
    await h.call('POST', BUILD, base);
    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases');
    const run1 = cases.body.data.find((c: { caseId: string }) => c.caseId === 'run-1');
    // c1: the expert's yes (3) predates the restriction, so nothing on it is restricted.
    expect(run1.items[0]).toMatchObject({
      key: 'c1',
      yesWeight: 3,
      totalWeight: 4,
      expert: { yesWeight: 0, totalWeight: 0, correctionIds: [] },
      correctionIds: ['j-3', 'j-2'],
    });
    // c2: the senior expert's yes (3) is restricted; the unclassified no (1) isn't.
    // Both are named on the item, only the restricted one under `expert`.
    expect(run1.items[1]).toMatchObject({
      key: 'c2',
      yesWeight: 3,
      totalWeight: 4,
      expert: { yesWeight: 3, totalWeight: 3, correctionIds: ['j-6'] },
      correctionIds: ['j-6', 'j-1'],
    });
    // On the answer, its reason says it was restricted; the expert's earlier one doesn't.
    expect(run1.items[2]).toMatchObject({
      key: 'answer',
      expert: { yesWeight: 3, totalWeight: 3, correctionIds: ['j-6'] },
      correctionIds: ['j-6', 'j-3', 'j-2'],
    });
    expect(run1.items[2].reasons).toContainEqual({
      verdict: 'yes',
      reason: 'the right firm',
      correctorGroupId: h.expertId,
      expert: true,
    });
    expect(run1.items[2].reasons).toContainEqual({
      verdict: 'yes',
      reason: 'right',
      correctorGroupId: h.expertId,
    });
  });

  test("a comparison's replays aren't cases: a turn corrected before the stamp (its output's replay report), and one stamped at its first correction", async () => {
    const correctReplay = (runId: string, output: unknown, context?: { replayOf: string }) =>
      h.corrections.record({
        tenantId,
        projectId: project,
        runId,
        run: {
          subject: subject(),
          input: { query: 'acme' },
          output,
          ...(context !== undefined && { context }),
        },
        ...says('u1', { items: [{ key: 'c1', rank: 0, verdict: 'right' }] }),
      });
    // Stored before the stamp: only the agent turn's own replay report says so.
    await correctReplay('run-replay-old', {
      matches: [{ id: 'c1' }],
      replay: { of: 'run-1', evalRunId: 'eval-1', tools: [] },
    });
    await correctReplay('run-replay-new', { matches: [{ id: 'c1' }] }, { replayOf: 'run-1' });
    const built = await h.call('POST', BUILD, base);
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    const cases = await h.call('GET', '/v1/test-sets/acme.matches/versions/1.0.0/cases?limit=50');
    expect(cases.body.data.map((c: { caseId: string }) => c.caseId).sort()).toEqual([
      'run-1',
      'run-2',
      'run-3',
    ]);
  });

  test('a binding that lists a replay anyway: the test set still leaves it out', async () => {
    const all = h.corrections;
    await all.record({
      tenantId,
      projectId: project,
      runId: 'run-replay-listed',
      run: {
        subject: subject(),
        input: { query: 'acme' },
        output: { matches: [{ id: 'c1' }] },
        context: { replayOf: 'run-1' },
      },
      ...says('u1', { items: [{ key: 'c1', rank: 0, verdict: 'right' }] }),
    });
    const listed = (
      await all.get({
        tenantId,
        correctionId: (
          await all.list({ tenantId, runId: 'run-replay-listed', limit: 1 })
        ).data[0]?.id as string,
      })
    )?.run;
    // A binding that doesn't filter: it lists the replay with the real runs.
    const unfiltered: CorrectionRegistryBinding = {
      ...all,
      listCorrectedRuns: async (input) => {
        const page = await (
          all.listCorrectedRuns as NonNullable<CorrectionRegistryBinding['listCorrectedRuns']>
        )(input);
        return {
          ...page,
          data: [
            ...page.data,
            {
              projectId: project,
              run: listed as never,
              corrections: (await all.list({ tenantId, runId: 'run-replay-listed', limit: 10 }))
                .data,
            },
          ],
        };
      },
    };
    const { call } = makeCall(createStubAppBindings(), unfiltered, testSetRegistry());
    const built = await call('POST', BUILD, base);
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    expect(built.body.caseCount).toBe(3);
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
    expect(again.body.error.code).toBe('test-set-already-registered');
  });

  test('a test set of another project: 409 test-set-project-mismatch, and nothing is built', async () => {
    expect((await h.call('POST', BUILD, base)).status).toBe(201);
    const elsewhere = { ...base, version: '2.0.0', projectId: randomUUID() };
    const res = await h.call('POST', BUILD, elsewhere);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('test-set-project-mismatch');
    expect(res.body.error.message).toContain(
      'belongs to another project; build its versions there',
    );
    expect(JSON.stringify(res.body)).not.toContain(project);
    expect(h.testSets.published.map((s) => s.version)).toEqual(['1.0.0']);
  });

  test('a binding that cannot list corrected runs: 501', async () => {
    const { listCorrectedRuns: _unsupported, ...without } = h.corrections;
    const { call } = makeCall(createStubAppBindings(), without, h.testSets);
    const res = await call('POST', BUILD, base);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('test-sets-not-supported');
    expect(h.testSets.published).toHaveLength(0);
  });
});

describe('GET /v1/test-sets/:id/versions/:version/cases', () => {
  test('pages with limit and cursor', async () => {
    await h.call('POST', BUILD, base);
    const path = '/v1/test-sets/acme.matches/versions/1.0.0/cases';
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
    const res = await h.call('GET', '/v1/test-sets/acme.matches/versions/9.9.9/cases');
    expect(res.body).toEqual({ data: [], hasMore: false });
  });
});
