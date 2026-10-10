// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/runs`: a run's output and parent on the wire, list filters
 * (`parentRunId`, `topLevel`, `include=output`), starting without
 * waiting (`options.wait: false` → 202), and resume driving the run on.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import type { NodeId, ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { turnFailureMessage } from '@kindgi/agents';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  InvokeAgentBindingInput,
  InvokeFlowBindingInput,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'runs-output-parent-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

function row(overrides: Partial<KernelRunRecord> = {}): KernelRunRecord {
  const at = '2026-09-30T00:00:00.000Z' as Timestamp;
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId,
    flowId: 'pack.flow',
    flowVersion: '1.0.0',
    status: 'completed',
    input: {},
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly listCalls: ListRunsInput[];
  readonly invocations: (InvokeAgentBindingInput | InvokeFlowBindingInput)[];
  readonly resumed: RunId[];
  readonly completed: string[];
}

function harness(rows: KernelRunRecord[]): Harness {
  const listCalls: ListRunsInput[] = [];
  const invocations: (InvokeAgentBindingInput | InvokeFlowBindingInput)[] = [];
  const resumed: RunId[] = [];
  const completed: string[] = [];
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) => rows.find((r) => r.runId === id) ?? null,
    listRuns: async (input: ListRunsInput) => {
      listCalls.push(input);
      return { data: rows };
    },
    completeToken: async (_t: TenantId, _r: RunId, tokenId: string) => {
      completed.push(tokenId);
      return { kind: 'ok' as const, value: undefined };
    },
  } as unknown as RunBinding;
  const started = rows[0] as KernelRunRecord;
  const runHandler: RunHandlerBinding = {
    invokeAgent: async (input) => {
      invocations.push(input);
      return { kind: 'ok', runId: started.runId };
    },
    invokeFlow: async (input) => {
      invocations.push(input);
      return { kind: 'ok', runId: started.runId };
    },
    resumeRun: async ({ runId }) => {
      resumed.push(runId);
      return { kind: 'ok', runId };
    },
  };
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler,
  });
  return { app, listCalls, invocations, resumed, completed };
}

async function call(
  h: Harness,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const res = await h.app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /v1/runs/:runId — output and parent', () => {
  test('a completed run carries its output; a child run its parent run and node', async () => {
    const parent = row({ output: { ranked: [1, 2] } });
    const child = row({
      parentRunId: parent.runId,
      parentNodeId: 'parse' as NodeId,
      parentScope: '',
      flowId: 'agent.turn',
    });
    const h = harness([parent, child]);

    const got = await call(h, `/v1/runs/${parent.runId}`);
    expect(got.status).toBe(200);
    expect(got.body.output).toEqual({ ranked: [1, 2] });
    expect(got.body).not.toHaveProperty('parentRunId');

    const gotChild = await call(h, `/v1/runs/${child.runId}`);
    expect(gotChild.body).toMatchObject({ parentRunId: parent.runId, parentNodeId: 'parse' });
    expect(gotChild.body).not.toHaveProperty('output');
  });
});

describe('GET /v1/runs — filters and include', () => {
  test('lists omit output unless include=output', async () => {
    const h = harness([row({ output: { big: true } })]);
    const plain = await call(h, '/v1/runs');
    expect((plain.body.data as Record<string, unknown>[])[0]).not.toHaveProperty('output');
    const withOutput = await call(h, '/v1/runs?include=output');
    expect((withOutput.body.data as Record<string, unknown>[])[0]?.output).toEqual({ big: true });
  });

  test('parentRunId and topLevel reach the binding', async () => {
    const h = harness([row()]);
    const parentRunId = randomUUID();
    await call(h, `/v1/runs?parentRunId=${parentRunId}`);
    await call(h, '/v1/runs?topLevel=true');
    expect(h.listCalls[0]?.parent).toEqual({ runId: parentRunId });
    expect(h.listCalls[0]?.topLevelOnly).toBeUndefined();
    expect(h.listCalls[1]?.topLevelOnly).toBe(true);
    expect(h.listCalls[1]?.parent).toBeUndefined();
  });

  test.each([
    ['an unknown include', '?include=journal'],
    ['topLevel other than true/false', '?topLevel=yes'],
    ['parentRunId with topLevel=true', `?parentRunId=${randomUUID()}&topLevel=true`],
  ])('%s is 400 bad-input', async (_label, query) => {
    const h = harness([row()]);
    const res = await call(h, `/v1/runs${query}`);
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('bad-input');
  });
});

describe('POST /v1/runs — options.wait', () => {
  test('wait: false → 202, and the binding is told not to wait', async () => {
    const h = harness([row({ status: 'running' })]);
    const res = await call(h, '/v1/runs', {
      flow: 'pack.flow',
      input: { grievanceId: 'g-1' },
      options: { wait: false },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
    expect(h.invocations[0]).toMatchObject({ flowId: 'pack.flow', wait: false });
  });

  test('default → 201 with the output; the binding gets no wait flag', async () => {
    const h = harness([row({ output: { done: true } })]);
    const res = await call(h, '/v1/runs', { agent: 'pack.agent', input: { userMessage: 'hi' } });
    expect(res.status).toBe(201);
    expect(res.body.output).toEqual({ done: true });
    expect(h.invocations[0]).not.toHaveProperty('wait');
  });

  test('a non-boolean wait is 400', async () => {
    const h = harness([row()]);
    const res = await call(h, '/v1/runs', {
      flow: 'pack.flow',
      input: {},
      options: { wait: 'no' },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/runs/:runId/resume', () => {
  // Not available in this release: every waitpoint belongs to an approval
  // (decided through the approvals routes) or to the runtime. The route
  // answers 422 and completes nothing, whatever the body names.
  test.each([
    [
      'an approval waitpoint, approved',
      { waitpointId: 'approval-1', value: { decided: 'approve' } },
    ],
    ['a runtime child waitpoint', { waitpointId: `child:${randomUUID()}:1`, value: {} }],
    ['no waitpoint', {}],
  ])('%s: 422 run-resume-not-supported, nothing completed or resumed', async (_name, body) => {
    const suspended = row({ status: 'suspended' });
    const h = harness([suspended]);
    const res = await call(h, `/v1/runs/${suspended.runId}/resume`, body);
    expect(res.status).toBe(422);
    const json = res.body as { error: { code: string; message: string } };
    expect(json.error.code).toBe('run-resume-not-supported');
    expect(json.error.message).toContain('/v1/approvals/{approvalId}/complete');
    expect(h.completed).toEqual([]);
    expect(h.resumed).toEqual([]);
  });
});

describe('run-handler error codes', () => {
  test.each(['flow-unbound', 'flow-runs-not-supported', 'flow-resume-not-supported'])(
    '%s maps to 422',
    async (code) => {
      const stubs = createStubAppBindings();
      const failing: RunHandlerBinding = {
        invokeAgent: async () => ({ kind: 'err', error: { code, message: code } }),
        invokeFlow: async () => ({ kind: 'err', error: { code, message: code } }),
        resumeRun: async () => ({ kind: 'err', error: { code, message: code } }),
      };
      const app = createApp({ ...stubs, resolveToken, runHandler: failing });
      const res = await app.request('/v1/runs', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ flow: 'pack.flow', input: {} }),
      });
      expect(res.status).toBe(422);
    },
  );
});

describe('GET /v1/runs/:runId: why a failed run failed', () => {
  const routing = turnFailureMessage({
    code: 'capability-routing-failed',
    message: 'No registered provider satisfies the capability declaration',
    cause: { code: 'capability-unsatisfiable', message: 'none', reasons: [] },
  });

  test("an agent turn's failure: its own code, message and cause; failureMessage as recorded", async () => {
    const failed = row({ status: 'failed', failureMessage: routing });
    const res = await call(harness([failed]), `/v1/runs/${failed.runId}`);
    expect(res.status).toBe(200);
    expect(res.body.failure).toEqual({
      code: 'capability-routing-failed',
      message: 'No registered provider satisfies the capability declaration',
      cause: { code: 'capability-unsatisfiable', message: 'none', reasons: [] },
    });
    expect(res.body.failureMessage).toBe(routing);
  });

  test('several joined: the first turn error; plain words: run-failed; none: run-failed, naming the run', async () => {
    const budget = turnFailureMessage({
      code: 'budget-exceeded',
      message: 'Agent turn steps budget exceeded (limit 1, observed 1)',
      kind: 'steps',
      limit: 1,
      observed: 1,
    });
    const joined = row({ status: 'failed', failureMessage: `${budget}; ${routing}` });
    const plain = row({
      status: 'failed',
      failureMessage: 'Interrupted: every attempt to resume it failed.',
    });
    const bare = row({ status: 'failed' });
    const h = harness([joined, plain, bare]);
    expect((await call(h, `/v1/runs/${joined.runId}`)).body.failure).toEqual({
      code: 'budget-exceeded',
      message: 'Agent turn steps budget exceeded (limit 1, observed 1)',
    });
    expect((await call(h, `/v1/runs/${plain.runId}`)).body.failure).toEqual({
      code: 'run-failed',
      message: 'Interrupted: every attempt to resume it failed.',
    });
    expect((await call(h, `/v1/runs/${bare.runId}`)).body.failure).toEqual({
      code: 'run-failed',
      message: `Run ${bare.runId} failed`,
    });
  });

  test("a turn's reason comes through; one without it has none", async () => {
    const timedOut = row({
      status: 'failed',
      failureMessage: turnFailureMessage({
        code: 'hitl-cancelled',
        message: 'Tool-call HITL cancelled for acme.post: timeout',
        reason: 'timeout',
      } as never),
    });
    const routed = row({ status: 'failed', failureMessage: routing });
    const h = harness([timedOut, routed]);
    expect((await call(h, `/v1/runs/${timedOut.runId}`)).body.failure).toEqual({
      code: 'hitl-cancelled',
      message: 'Tool-call HITL cancelled for acme.post: timeout',
      reason: 'timeout',
    });
    expect((await call(h, `/v1/runs/${routed.runId}`)).body.failure).not.toHaveProperty('reason');
  });

  test('only a failed run has one, in lists too', async () => {
    const done = row({ status: 'completed' });
    const cancelled = row({ status: 'cancelled', failureMessage: 'cancelled by user:alice' });
    const failed = row({ status: 'failed', failureMessage: routing });
    const h = harness([done, cancelled, failed]);
    expect((await call(h, `/v1/runs/${done.runId}`)).body).not.toHaveProperty('failure');
    expect((await call(h, `/v1/runs/${cancelled.runId}`)).body).not.toHaveProperty('failure');
    const list = (await call(h, '/v1/runs')).body.data as Record<string, unknown>[];
    expect(list.map((r) => (r.failure as { code?: string } | undefined)?.code)).toEqual([
      undefined,
      undefined,
      'capability-routing-failed',
    ]);
  });
});
