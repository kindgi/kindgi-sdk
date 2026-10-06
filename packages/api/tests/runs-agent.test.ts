// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent's turn names its agent: the run record carries `agent` (id,
 * version, conversation), and `GET /v1/runs?agentId=` lists one agent's
 * turns. Other runs have no `agent`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import { createStubAppBindings } from '@kindgi/testing';
import type { ConversationId, ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { InvokeAgentBindingInput, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-agent-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const conversationId = randomUUID() as ConversationId;

function record(overrides: Partial<KernelRunRecord>): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId: randomUUID() as ProjectId,
    flowId: 'agent.turn',
    flowVersion: '1.1.0',
    status: 'completed',
    input: 'hello',
    dryRun: false,
    createdAt: '2026-10-05T08:00:00.000Z' as Timestamp,
    updatedAt: '2026-10-05T08:00:01.000Z' as Timestamp,
    ...overrides,
  };
}

const turn = record({
  agent: { id: 'acme.desk.echo-agent', version: '0.3.0', conversationId },
});
const flowRun = record({ flowId: 'acme.desk.triage', flowVersion: '0.1.0' });
const liveTurn = record({
  agent: {
    id: 'acme.desk.echo-agent',
    version: '0.2.0',
    conversationId,
    via: 'live',
    liveScope: {
      kind: 'segment',
      projectId: randomUUID() as ProjectId,
      path: [{ key: 'company', value: 'acme' }],
    },
  },
});

function app() {
  const stubs = createStubAppBindings();
  const listed: ListRunsInput[] = [];
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, runId: string) =>
      [turn, flowRun, liveTurn].find((r) => r.runId === runId) ?? null,
    listRuns: async (input: ListRunsInput) => {
      listed.push(input);
      return { data: [turn, flowRun], hasMore: false };
    },
  } as unknown as RunBinding;
  const built = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  return { built, listed };
}

async function get(path: string) {
  const h = app();
  const res = await h.built.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, ...h };
}

describe('a run names its agent', () => {
  test("an agent's turn carries the agent, its version and the conversation", async () => {
    const answer = await get(`/v1/runs/${turn.runId}`);
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      flowId: 'agent.turn',
      agent: { id: 'acme.desk.echo-agent', version: '0.3.0', conversationId },
    });
  });

  test('a turn records how its version was chosen, and the live scope', async () => {
    const answer = await get(`/v1/runs/${liveTurn.runId}`);
    expect(answer.status).toBe(200);
    const scope = liveTurn.agent?.liveScope;
    expect(answer.json.agent).toEqual({
      id: 'acme.desk.echo-agent',
      version: '0.2.0',
      conversationId,
      via: 'live',
      liveScope: {
        kind: 'segment',
        projectId: scope?.kind === 'segment' ? scope.projectId : undefined,
        path: [{ key: 'company', value: 'acme' }],
      },
    });
  });

  test('without a recorded choice, no via', async () => {
    const answer = await get(`/v1/runs/${turn.runId}`);
    expect(answer.json.agent).not.toHaveProperty('via');
    expect(answer.json.agent).not.toHaveProperty('liveScope');
  });

  test('a flow run has no agent', async () => {
    const answer = await get(`/v1/runs/${flowRun.runId}`);
    expect(answer.status).toBe(200);
    expect(answer.json).not.toHaveProperty('agent');
  });

  test('the list carries it too', async () => {
    const answer = await get('/v1/runs');
    const data = answer.json.data as Record<string, unknown>[];
    expect(data[0]).toMatchObject({ agent: { id: 'acme.desk.echo-agent' } });
    expect(data[1]).not.toHaveProperty('agent');
  });
});

describe('GET /v1/runs?agentId=', () => {
  test('passes the agent to the run binding, with the other filters', async () => {
    const answer = await get('/v1/runs?agentId=acme.desk.echo-agent&topLevel=true');
    expect(answer.status).toBe(200);
    expect(answer.listed).toEqual([
      expect.objectContaining({ agentId: 'acme.desk.echo-agent', topLevelOnly: true }),
    ]);
  });

  test('no agentId: no agent filter', async () => {
    const answer = await get('/v1/runs');
    expect(answer.listed[0]).not.toHaveProperty('agentId');
  });

  test('an empty agentId is a 400, and no query', async () => {
    const answer = await get('/v1/runs?agentId=');
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({
      code: 'bad-input',
      message: '`agentId` must not be empty',
    });
    expect(answer.listed).toEqual([]);
  });
});

describe('POST /v1/runs — segments', () => {
  function starting() {
    const started: InvokeAgentBindingInput[] = [];
    const runHandler = {
      invokeAgent: async (input: InvokeAgentBindingInput) => {
        started.push(input);
        return { kind: 'err', error: { code: 'bad-input', message: 'recorded' } };
      },
    } as unknown as RunHandlerBinding;
    const built = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const start = (body: unknown) =>
      built.request('/v1/runs', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { start, started };
  }

  test('the segment path reaches the run handler, in order', async () => {
    const { start, started } = starting();
    const segments = [
      { key: 'company', value: 'acme' },
      { key: 'role', value: 'counsel' },
    ];
    await start({ agent: 'acme.desk.echo-agent', input: 'hi', segments });
    expect(started[0]?.segments).toEqual(segments);
  });

  test('no segments: none passed', async () => {
    const { start, started } = starting();
    await start({ agent: 'acme.desk.echo-agent', input: 'hi' });
    expect(started[0]).not.toHaveProperty('segments');
  });

  test.each([
    ['not an array', { company: 'acme' }],
    ['an upper-case key', [{ key: 'Company', value: 'acme' }]],
    ['an empty value', [{ key: 'company', value: '' }]],
    [
      'a repeated key',
      [
        { key: 'company', value: 'a' },
        { key: 'company', value: 'b' },
      ],
    ],
  ])('%s → 400, no run', async (_name, segments) => {
    const { start, started } = starting();
    const res = await start({ agent: 'acme.desk.echo-agent', input: 'hi', segments });
    expect(res.status).toBe(400);
    expect(started).toEqual([]);
  });
});
