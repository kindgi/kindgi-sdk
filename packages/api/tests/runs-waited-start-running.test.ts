// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A waited start (`POST /v1/runs`, `wait` left true) can answer `201` with
 * its run still `running`: when a read the run needs fails part-way, the
 * run is left for a later resume, and the start answers the run as it is.
 * A repeat with the same idempotency key gets that same answer again, as
 * any kept answer is replayed, not the run as it is now:
 * `GET /v1/runs/{runId}` gives that.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { InvokeAgentBindingInput, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-waited-start-running-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** A server whose run handler answers a run left `running`, and the run, which can finish later. */
function world() {
  const runId = randomUUID() as RunId;
  let current: KernelRunRecord = {
    runId,
    tenantId,
    projectId: randomUUID() as ProjectId,
    flowId: 'agent.turn',
    flowVersion: '1.1.0',
    status: 'running',
    input: 'hello',
    dryRun: false,
    createdAt: '2026-11-04T08:00:00.000Z' as Timestamp,
    updatedAt: '2026-11-04T08:00:01.000Z' as Timestamp,
  };
  const started: InvokeAgentBindingInput[] = [];
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: string) => (id === runId ? current : null),
  } as unknown as RunBinding;
  const runHandler = {
    invokeAgent: async (input: InvokeAgentBindingInput) => {
      started.push(input);
      return { kind: 'ok', runId };
    },
  } as unknown as RunHandlerBinding;
  const built = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler,
  });
  const start = (key: string) =>
    built.request('/v1/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ agent: 'acme.desk.echo-agent', input: 'hello' }),
    });
  const get = () =>
    built.request(`/v1/runs/${runId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const finish = () => {
    current = {
      ...current,
      status: 'completed',
      output: 'done',
      updatedAt: '2026-11-04T08:05:00.000Z' as Timestamp,
    };
  };
  return { runId, started, start, get, finish };
}

describe('a waited start whose run is still running: a read failed part-way', () => {
  test('answers 201 with the run `running` and no output', async () => {
    const w = world();
    const res = await w.start(randomUUID());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: w.runId, status: 'running' });
    expect(body).not.toHaveProperty('output');
  });

  test('a repeat with its key gets that same answer, not the run as it is now; GET gives that', async () => {
    const w = world();
    const key = randomUUID();
    const first = await w.start(key);
    const answered = await first.text();
    w.finish();

    const again = await w.start(key);
    expect(again.status).toBe(201);
    expect(again.headers.get('x-idempotent-replay')).toBe('true');
    expect(await again.text()).toBe(answered);
    expect(JSON.parse(answered)).toMatchObject({ id: w.runId, status: 'running' });
    expect(w.started).toHaveLength(1);

    const now = await w.get();
    expect(now.status).toBe(200);
    expect(await now.json()).toMatchObject({ id: w.runId, status: 'completed', output: 'done' });
  });
});
