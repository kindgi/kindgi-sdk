// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `POST /v1/eval-suites/{suiteId}/runs` for a test set: a comparison eval run. */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { RunId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import type {
  AgentRegistryBinding,
  EvalRun,
  EvalRunBinding,
  EvalSuite,
  EvalSuiteRegistryBinding,
  FlowRegistryBinding,
  JudgedComparisonSummary,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';
import { createApp, createInProcessEvalRunBinding, createJudgedDispatcher } from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'eval-comparison-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const unused = async () => ({
  kind: 'err' as const,
  error: { code: 'bad-input', message: 'unused' },
});
const runHandler = {
  invokeAgent: unused,
  invokeFlow: unused,
  resumeRun: unused,
} as unknown as RunHandlerBinding;

const suite: EvalSuite = {
  id: 'acme.set',
  tenantId,
  version: '1.0.0',
  kind: 'judged',
  spec: { source: 'judgments', caseCount: 1 },
};

async function setup() {
  const cases = inMemoryCaseStore();
  await cases.putCases({
    tenantId,
    suiteId: suite.id,
    version: suite.version,
    cases: [
      {
        caseId: 'case-1',
        subject: { kind: 'agent', id: 'acme.agent', version: '1.0.0' },
        input: 'hello',
        output: { appended: [{ role: 'agent', content: 'Hi.' }] },
        items: [
          {
            key: 'answer',
            pointer: '/appended/0/content',
            yes: 1,
            no: 0,
            yesWeight: 1,
            totalWeight: 1,
            reasons: [],
          },
        ],
      },
    ],
  });
  const registry = {
    get: async ({ suiteId }: { suiteId: string }) => (suiteId === suite.id ? suite : null),
  } as unknown as EvalSuiteRegistryBinding;
  const binding = createInProcessEvalRunBinding({
    suiteRegistry: registry,
    subject: {
      invoke: async () => ({
        output: { appended: [{ role: 'agent', content: 'Hi.' }] },
        runId: 'replay-1' as RunId,
      }),
    },
    dispatchers: { judged: createJudgedDispatcher({ cases }) },
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    evalSuiteRegistry: registry,
    evalRunBinding: binding,
  });
  const start = (body: Record<string, unknown>) =>
    app.request(`/v1/eval-suites/${suite.id}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: randomUUID(),
        agentRef: { agentId: 'acme.agent', version: '2.0.0' },
        ...body,
      }),
    });
  return { app, binding, start };
}

async function settled(binding: EvalRunBinding, runId: string): Promise<EvalRun> {
  for (let i = 0; i < 200; i++) {
    const run = await binding.get({ tenantId, runId: runId as RunId });
    if (run !== null && run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the run did not settle');
}

describe('a comparison eval run over the API', () => {
  test('starts with its settings, keeps them on the run, and ends with the summary', async () => {
    const { app, binding, start } = await setup();
    const res = await start({
      reads: 'live',
      repetitions: 2,
      k: 5,
      classWeights: 'restricted-only',
    });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const run = await settled(binding, runId);
    expect(run.status).toBe('completed');
    const summary = (run.result as { summary: JudgedComparisonSummary }).summary;
    expect(summary).toMatchObject({
      status: 'completed',
      cases: 1,
      repetitions: 2,
      reads: 'live',
      classWeights: 'restricted-only',
    });

    const got = await app.request(`/v1/eval-runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await got.json()) as Record<string, unknown>).comparison).toEqual({
      baseline: 'recorded',
      reads: 'live',
      repetitions: 2,
      k: 5,
      classWeights: 'restricted-only',
    });
  });

  test('without settings, the defaults run and nothing is recorded on the run', async () => {
    const { binding, start } = await setup();
    const { runId } = (await (await start({})).json()) as { runId: string };
    const run = await settled(binding, runId);
    expect(run.comparison).toBeUndefined();
    expect((run.result as { summary: JudgedComparisonSummary }).summary).toMatchObject({
      reads: 'recorded',
      repetitions: 1,
      classWeights: 'as-recorded',
    });
  });

  test.each([
    [{ reads: 'sometimes' }, "`reads` must be 'recorded' or 'live'"],
    [{ repetitions: 0 }, '`repetitions` must be an integer from 1 to 10'],
    [{ repetitions: 11 }, '`repetitions` must be an integer from 1 to 10'],
    [{ k: 1.5 }, '`k` must be an integer from 1 to 100'],
    [{ classWeights: 'some' }, "`classWeights` must be 'as-recorded'"],
    [{ baseline: 'yesterday' }, '`baseline` must be'],
    [{ baseline: { agentId: 'acme.agent' } }, 'needs `agentId` and `version`'],
    [
      { baseline: { live: { projectId: 'p-1', segments: { tier: 'gold' } } } },
      '`baseline.live.segments` must be an array of {key, value}, coarse to fine',
    ],
    [
      { baseline: { live: { projectId: 'p-1', segments: [{ key: 'tier', value: 1 }] } } },
      '`baseline.live.segments`: each segment is {key: string, value: string}',
    ],
    [
      {
        baseline: {
          live: {
            projectId: 'p-1',
            segments: [
              { key: 'tier', value: 'gold' },
              { key: 'tier', value: 'silver' },
            ],
          },
        },
      },
      '`baseline.live.segments`: the key',
    ],
    [
      { baseline: { live: { segments: [{ key: 'tier', value: 'gold' }] } } },
      'it needs `baseline.live.projectId`',
    ],
  ])('%j → 400', async (body, message) => {
    const { start } = await setup();
    const res = await start(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
  });

  test('a baseline that is not the recording is refused when the run starts', async () => {
    const { start } = await setup();
    for (const baseline of [
      { agentId: 'acme.agent', version: '1.0.0' },
      { live: { projectId: 'p-1', segments: [{ key: 'tier', value: 'gold' }] } },
    ]) {
      const res = await start({ baseline });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("Only `baseline: 'recorded'` runs today");
    }
  });

  test('a candidate without a version is refused', async () => {
    const { start } = await setup();
    const res = await start({ agentRef: { agentId: 'acme.agent' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('`agentRef.version` is required');
  });
});

describe('a flow candidate with some of its agents or tools at other versions', () => {
  const flowSuite: EvalSuite = { ...suite, id: 'acme.flow-set' };
  const flow = {
    id: 'acme.flow',
    version: '1.0.0',
    nodes: [
      { id: 'look', kind: 'tool', ref: 'acme.lookup' },
      { id: 'draft', kind: 'agent', ref: 'acme.drafter' },
      { id: 'check', kind: 'agent', ref: 'acme.checker', config: { version: '0.1.0' } },
    ],
    edges: [],
  };
  const agentVersions: Record<string, { unregisteredAt?: string }> = {
    'acme.drafter@0.2.0': {},
    'acme.checker@0.3.0': {},
    'acme.drafter@0.0.1': { unregisteredAt: '2026-10-01T00:00:00.000Z' },
  };

  async function setupFlow() {
    const cases = inMemoryCaseStore();
    await cases.putCases({
      tenantId,
      suiteId: flowSuite.id,
      version: flowSuite.version,
      cases: [
        {
          caseId: 'case-f',
          subject: { kind: 'flow', id: 'acme.flow', version: '1.0.0' },
          input: { name: 'Sam' },
          output: { reply: 'Hi.' },
          items: [
            {
              key: 'output',
              pointer: '',
              yes: 1,
              no: 0,
              yesWeight: 1,
              totalWeight: 1,
              reasons: [],
            },
          ],
        },
      ],
    });
    const registry = {
      get: async ({ suiteId }: { suiteId: string }) =>
        suiteId === flowSuite.id ? flowSuite : null,
    } as unknown as EvalSuiteRegistryBinding;
    const invoked: Record<string, unknown>[] = [];
    const binding = createInProcessEvalRunBinding({
      suiteRegistry: registry,
      subject: {
        invoke: async (input) => {
          invoked.push(input as unknown as Record<string, unknown>);
          return { output: { reply: 'Hi.' }, runId: 'replay-f' as RunId };
        },
      },
      dispatchers: { judged: createJudgedDispatcher({ cases }) },
    });
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      evalSuiteRegistry: registry,
      evalRunBinding: binding,
      flowRegistry: {
        getVersion: async ({ flowId, version }: { flowId: string; version: string }) =>
          flowId === flow.id && version === flow.version ? flow : null,
      } as unknown as FlowRegistryBinding,
      agentRegistry: {
        getVersion: async ({ agentId, version }: { agentId: string; version: string }) => {
          const found = agentVersions[`${agentId}@${version}`];
          return found === undefined ? null : { id: agentId, version, ...found };
        },
      } as unknown as AgentRegistryBinding,
      toolRegistry: {
        getVersion: async ({ toolId, version }: { toolId: string; version: string }) =>
          toolId === 'acme.lookup' && version === '2.0.0' ? { id: toolId, version } : null,
      } as unknown as ToolRegistryBinding,
    });
    const start = (body: Record<string, unknown>) =>
      app.request(`/v1/eval-suites/${flowSuite.id}/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: randomUUID(),
          flowRef: { flowId: 'acme.flow', version: '1.0.0' },
          ...body,
        }),
      });
    return { binding, start, invoked };
  }

  test('replays the flow with them, keeps them on the run, and names them on the candidate', async () => {
    const { binding, start, invoked } = await setupFlow();
    const versions = {
      agents: { 'acme.drafter': '0.2.0', 'acme.checker': '0.3.0' },
      tools: { 'acme.lookup': '2.0.0' },
    };
    const res = await start({ versions });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const run = await settled(binding, runId);
    expect(run.comparison?.versions).toEqual(versions);
    expect(invoked[0]?.versions).toEqual(versions);
    const summary = (run.result as { summary: JudgedComparisonSummary }).summary;
    expect(summary.candidate).toEqual({
      kind: 'flow',
      flowId: 'acme.flow',
      version: '1.0.0',
      versions,
    });
  });

  test('without them, a flow replay is the flow version as published', async () => {
    const { binding, start, invoked } = await setupFlow();
    const { runId } = (await (await start({})).json()) as { runId: string };
    const run = await settled(binding, runId);
    expect(invoked[0]?.versions).toBeUndefined();
    expect((run.result as { summary: JudgedComparisonSummary }).summary.candidate).toEqual({
      kind: 'flow',
      flowId: 'acme.flow',
      version: '1.0.0',
    });
  });

  test('an id the flow does not use, or a version that is not published, is refused, each named', async () => {
    const { start } = await setupFlow();
    const res = await start({
      versions: {
        agents: { 'acme.x': '1.0.0', 'acme.drafter': '9.9.9', 'acme.checker': '0.3.0' },
        tools: { 'acme.lookup': '0.0.9', 'acme.y': '1.0.0' },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { issues: unknown[] } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.message).toBe("The versions don't fit flow acme.flow 1.0.0 (4 issues)");
    expect(body.error.details.issues).toEqual([
      { path: '/versions/agents/acme.x', message: "flow acme.flow 1.0.0 doesn't use agent acme.x" },
      { path: '/versions/agents/acme.drafter', message: 'agent acme.drafter has no version 9.9.9' },
      { path: '/versions/tools/acme.lookup', message: 'tool acme.lookup has no version 0.0.9' },
      { path: '/versions/tools/acme.y', message: "flow acme.flow 1.0.0 doesn't use tool acme.y" },
    ]);
  });

  test('an unregistered agent version is refused', async () => {
    const { start } = await setupFlow();
    const res = await start({ versions: { agents: { 'acme.drafter': '0.0.1' } } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('agent acme.drafter 0.0.1 is unregistered');
  });

  test('a flow version that is not registered is refused', async () => {
    const { start } = await setupFlow();
    const res = await start({
      flowRef: { flowId: 'acme.flow', version: '3.0.0' },
      versions: { agents: { 'acme.drafter': '0.2.0' } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("flow acme.flow 3.0.0 isn't registered");
  });

  test.each([
    [{ versions: 'acme.drafter@0.2.0' }, '`versions` must be an object: { agents?, tools? }'],
    [{ versions: { agents: { 'acme.drafter': 2 } } }, '`versions.agents` must be an object of'],
    [{ versions: { tools: { '': '1.0.0' } } }, '`versions.tools` must be an object of'],
    [{ versions: { models: {} } }, '`versions` takes `agents` and `tools`, not `models`'],
    [
      {
        flowRef: undefined,
        agentRef: { agentId: 'acme.agent', version: '1.0.0' },
        versions: { agents: { a: '1.0.0' } },
      },
      '`versions` runs a flow with some of its agents or tools at other versions: it needs `flowRef`.',
    ],
  ])('%j → 400', async (body, message) => {
    const { start } = await setupFlow();
    const res = await start(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
  });

  test('versions naming nothing are no versions', async () => {
    const { binding, start } = await setupFlow();
    const { runId } = (await (await start({ versions: { agents: {} } })).json()) as {
      runId: string;
    };
    const run = await settled(binding, runId);
    expect(run.comparison).toBeUndefined();
  });
});
