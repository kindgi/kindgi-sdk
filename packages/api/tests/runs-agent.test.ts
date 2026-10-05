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
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

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

function app() {
  const stubs = createStubAppBindings();
  const listed: ListRunsInput[] = [];
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, runId: string) =>
      [turn, flowRun].find((r) => r.runId === runId) ?? null,
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
