// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `createApp({ logger })`: each request's trace context (`traceparent`
 * honoured or minted, `traceresponse` answered), its access line at the
 * level that keeps `info` readable, a 500 logged with its error, and the
 * trace handed to the run a request starts.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type LogLevel, createLogger } from '@kindgi/log';
import type { RunBinding } from '@kindgi/runtime';
import type { RunId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { InvokeAgentBindingInput, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'request-log-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const INCOMING = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function harness(
  options: { level?: LogLevel; withLogger?: boolean; runReadsThrow?: boolean } = {},
) {
  const lines: string[] = [];
  const logger = createLogger({ level: options.level ?? 'debug', write: (l) => lines.push(l) });
  const started: InvokeAgentBindingInput[] = [];
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    // An empty runtime: no runs to list, none to read.
    listRuns: async () => ({ data: [] }),
    getRun: async () => null,
    ...(options.runReadsThrow === true && {
      getRun: async () => {
        throw new Error('the database is gone, at postgres://kindgi:hunter2@db/kindgi');
      },
    }),
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {
      invokeAgent: async (input: InvokeAgentBindingInput) => {
        started.push(input);
        return { kind: 'err', error: { code: 'agent-not-found', message: 'no such agent' } };
      },
    } as unknown as RunHandlerBinding,
    ...(options.withLogger !== false && { logger }),
  });
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const send = (
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
  return { send, records, started };
}

const access = (records: Record<string, unknown>[]) => records.filter((r) => r.route !== undefined);

describe('the access line', () => {
  test('a successful read is debug, with the route pattern (not the raw path), the ids and the tenant', async () => {
    const h = harness();
    const runId = randomUUID();
    await h.send('GET', `/v1/runs/${runId}`);
    const [line] = access(h.records());
    expect(line).toMatchObject({
      subsystem: 'http',
      method: 'GET',
      route: '/v1/runs/:runId',
      status: expect.any(Number),
      tenantId,
      requestId: expect.stringMatching(/^req-/),
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(String(line?.message)).toMatch(/^GET \/v1\/runs\/:runId \d{3} \d+ms$/);
    expect(JSON.stringify(h.records())).not.toContain(runId);
  });

  test('reads are debug and writes and 4xx are info, so info stays readable under polling', async () => {
    const h = harness();
    await h.send('GET', '/health');
    await h.send('GET', '/v1/runs');
    await h.send('GET', '/v1/runs/not-a-uuid');
    await h.send('POST', '/v1/runs', {
      body: { agent: 'acme.agent', input: { userMessage: 'hi' } },
    });
    expect(access(h.records()).map((r) => [r.method, r.route, r.level])).toEqual([
      ['GET', '/health', 'debug'],
      ['GET', '/v1/runs', 'debug'],
      ['GET', '/v1/runs/:runId', 'info'],
      ['POST', '/v1/runs', 'info'],
    ]);
  });

  test('at info (the default), the polling reads write nothing', async () => {
    const h = harness({ level: 'info' });
    await h.send('GET', '/health');
    await h.send('GET', '/v1/runs');
    expect(h.records()).toEqual([]);
  });

  test('a 500 is an error line, and the error itself is logged, scrubbed', async () => {
    const h = harness({ runReadsThrow: true });
    const res = await h.send('GET', `/v1/runs/${randomUUID()}`);
    expect(res.status).toBe(500);
    const recs = h.records();
    const unhandled = recs.find((r) => r.message === 'unhandled error');
    expect(unhandled).toMatchObject({ level: 'error', subsystem: 'http', tenantId });
    expect((unhandled?.err as { message: string }).message).toBe(
      'the database is gone, at postgres://kindgi:***@db/kindgi',
    );
    expect(access(recs)[0]).toMatchObject({ level: 'error', status: 500 });
    expect(JSON.stringify(recs)).not.toContain('hunter2');
  });
});

describe('the trace context', () => {
  test("a caller's traceparent is honoured: its trace id on the records and in traceresponse, with a new span", async () => {
    const h = harness();
    const res = await h.send('GET', '/v1/runs', { headers: { traceparent: INCOMING } });
    const answered = res.headers.get('traceresponse') ?? '';
    expect(answered).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(answered).not.toContain('00f067aa0ba902b7');
    expect(access(h.records())[0]).toMatchObject({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  });

  test('a malformed traceparent is replaced by a fresh trace, never trusted', async () => {
    const h = harness();
    const res = await h.send('GET', '/v1/runs', { headers: { traceparent: '00-not-a-trace-01' } });
    expect(res.headers.get('traceresponse')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(res.headers.get('traceresponse')).not.toContain('not-a-trace');
  });

  test('a run a request starts gets its trace: the run handler is handed the trace id', async () => {
    const h = harness();
    await h.send('POST', '/v1/runs', {
      body: { agent: 'acme.agent', input: { userMessage: 'hi' } },
      headers: { traceparent: INCOMING },
    });
    expect(h.started[0]?.trace).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  test('without a logger the app stays quiet and still answers traceresponse', async () => {
    const h = harness({ withLogger: false });
    const res = await h.send('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('traceresponse')).toMatch(/^00-[0-9a-f]{32}-/);
    expect(h.records()).toEqual([]);
  });
});

describe('a run on the wire', () => {
  test('traceId is serialized when the run has one', async () => {
    const stubs = createStubAppBindings();
    const runId = randomUUID() as RunId;
    const row = {
      runId,
      tenantId,
      projectId: randomUUID(),
      flowId: 'agent.turn',
      flowVersion: '1.0.0',
      status: 'completed',
      dryRun: false,
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    };
    const app = createApp({
      ...stubs,
      kernelBinding: {
        ...stubs.kernelBinding,
        run: { ...stubs.kernelBinding.run, getRun: async () => row } as unknown as RunBinding,
      },
      resolveToken,
      runHandler: {} as RunHandlerBinding,
    });
    const res = await app.request(`/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await res.json()).toMatchObject({
      id: runId,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
  });
});
