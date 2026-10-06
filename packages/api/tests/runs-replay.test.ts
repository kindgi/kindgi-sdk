// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A replay run names the run it replays and its eval run: the run record
 * carries `replayOf` and `evalRunId`, and `GET /v1/runs` leaves replays
 * out unless `?replays=` or `?evalRunId=` asks for them.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord, ListRunsInput, RunBinding } from '@kindgi/runtime';
import { createStubAppBindings } from '@kindgi/testing';
import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-replay-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

function record(overrides: Partial<KernelRunRecord>): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId: randomUUID() as ProjectId,
    flowId: 'acme.desk.triage',
    flowVersion: '0.1.0',
    status: 'completed',
    input: 'hello',
    dryRun: false,
    createdAt: '2026-10-05T08:00:00.000Z' as Timestamp,
    updatedAt: '2026-10-05T08:00:01.000Z' as Timestamp,
    ...overrides,
  };
}

const replayed = randomUUID() as RunId;
const replay = record({
  replayOf: replayed,
  evalRunId: 'eval-1',
  versions: { agents: { 'acme.desk.drafter': '0.2.0' } },
});
const plain = record({});

function app() {
  const stubs = createStubAppBindings();
  const listed: ListRunsInput[] = [];
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, runId: string) =>
      [replay, plain].find((r) => r.runId === runId) ?? null,
    listRuns: async (input: ListRunsInput) => {
      listed.push(input);
      return { data: [replay, plain], hasMore: false };
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

describe('a run names the run it replays', () => {
  test('a replay run carries replayOf and evalRunId', async () => {
    const answer = await get(`/v1/runs/${replay.runId}`);
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ replayOf: replayed, evalRunId: 'eval-1' });
  });

  test('a run that ran some blocks at other versions says which', async () => {
    const answer = await get(`/v1/runs/${replay.runId}`);
    expect(answer.json.versions).toEqual({ agents: { 'acme.desk.drafter': '0.2.0' } });
  });

  test('an ordinary run has neither', async () => {
    const answer = await get(`/v1/runs/${plain.runId}`);
    expect(answer.json).not.toHaveProperty('replayOf');
    expect(answer.json).not.toHaveProperty('evalRunId');
    expect(answer.json).not.toHaveProperty('versions');
  });

  test('the list carries them too', async () => {
    const answer = await get('/v1/runs');
    const data = answer.json.data as Record<string, unknown>[];
    expect(data[0]).toMatchObject({ replayOf: replayed, evalRunId: 'eval-1' });
    expect(data[1]).not.toHaveProperty('replayOf');
  });
});

describe('GET /v1/runs?replays= and ?evalRunId=', () => {
  test('replays are left out by default', async () => {
    const answer = await get('/v1/runs');
    expect(answer.listed[0]).toMatchObject({ replays: 'exclude' });
    expect(answer.listed[0]).not.toHaveProperty('evalRunId');
  });

  test.each(['exclude', 'include', 'only'] as const)(
    'replays=%s goes to the binding',
    async (v) => {
      const answer = await get(`/v1/runs?replays=${v}`);
      expect(answer.status).toBe(200);
      expect(answer.listed[0]).toMatchObject({ replays: v });
    },
  );

  test('evalRunId goes to the binding and includes replays', async () => {
    const answer = await get('/v1/runs?evalRunId=eval-1');
    expect(answer.status).toBe(200);
    expect(answer.listed[0]).toMatchObject({ replays: 'include', evalRunId: 'eval-1' });
  });

  test('evalRunId with replays=only keeps only', async () => {
    const answer = await get('/v1/runs?evalRunId=eval-1&replays=only');
    expect(answer.listed[0]).toMatchObject({ replays: 'only', evalRunId: 'eval-1' });
  });

  test.each([
    ['/v1/runs?replays=sometimes', '`replays` must be `exclude`, `include` or `only`'],
    ['/v1/runs?evalRunId=', '`evalRunId` must not be empty'],
    [
      '/v1/runs?evalRunId=eval-1&replays=exclude',
      '`evalRunId` and `replays=exclude` cannot be combined',
    ],
  ])('%s is a 400, and no query', async (path, message) => {
    const answer = await get(path);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'bad-input', message });
    expect(answer.listed).toEqual([]);
  });
});
