// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import type { RunEvent } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';
import { sseFetch } from '../support/sse-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_RUN = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  flowId: 'acme.drafter',
  flowVersion: '1.0.0',
  status: 'queued' as const,
  dryRun: false,
  createdAt: '2026-09-20T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
};

describe('runs.start', () => {
  it('POSTs /v1/runs with agent body + Idempotency-Key and returns Run', async () => {
    const stub = jsonFetch(WIRE_RUN, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const run = await client.runs.start({
      agent: 'acme.drafter' as never,
      input: { draftId: 'd-1' },
      idempotencyKey: 'idem-r',
    });

    expect(run.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(run.status).toBe('queued');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/runs');
    expect(req.headers['idempotency-key']).toBe('idem-r');
    expect(JSON.parse(req.body ?? '{}')).toMatchObject({
      agent: 'acme.drafter',
      input: { draftId: 'd-1' },
    });
  });

  it('POSTs flow body variant', async () => {
    const stub = jsonFetch(WIRE_RUN, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.runs.start({
      flow: 'ingest.contract-pdf',
      flowVersion: '1.0.0',
      input: {},
    });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toMatchObject({
      flow: 'ingest.contract-pdf',
      flowVersion: '1.0.0',
    });
  });
});

describe('runs.start — options.wait and output', () => {
  it('sends options.wait: false and accepts the 202 row', async () => {
    const stub = jsonFetch({ ...WIRE_RUN, status: 'running' }, { status: 202 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const run = await client.runs.start({
      flow: 'acme.cases' as never,
      input: { grievanceId: 'g-1' },
      options: { wait: false },
    });
    expect(run.status).toBe('running');
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toMatchObject({ options: { wait: false } });
  });

  it('returns the public run token, typed, when the deployment issues them', async () => {
    const stub = jsonFetch(
      {
        ...WIRE_RUN,
        status: 'running',
        publicAccessToken: 'kgi_pt_payload.signature',
        publicAccessTokenExpiresAt: '2026-10-02T12:15:00.000Z',
      },
      { status: 202 },
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const run = await client.runs.start({
      flow: 'acme.cases' as never,
      input: {},
      options: { wait: false },
    });
    // Typed on the result: no cast needed to hand it to a browser.
    const token: string | undefined = run.publicAccessToken;
    expect(token).toBe('kgi_pt_payload.signature');
    expect(run.publicAccessTokenExpiresAt).toBe('2026-10-02T12:15:00.000Z');
  });

  it('surfaces output and the parent link from the wire row', async () => {
    const stub = jsonFetch({
      ...WIRE_RUN,
      status: 'completed',
      output: { ranked: ['a', 'b'] },
      parentRunId: '00000000-0000-4000-8000-000000000009',
      parentNodeId: 'parse',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const run = await client.runs.get('00000000-0000-4000-8000-000000000001' as never);
    expect(run.output).toEqual({ ranked: ['a', 'b'] });
    expect(run.parentRunId).toBe('00000000-0000-4000-8000-000000000009');
    expect(run.parentNodeId).toBe('parse');
  });
});

describe('runs.list — filters', () => {
  it('sends parentRunId, topLevel and include=output', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await client.runs.list({
      parentRunId: '00000000-0000-4000-8000-000000000009' as never,
      includeOutput: true,
    });
    await client.runs.list({ topLevel: true });
    const first = new URL(stub.calls[0]?.url ?? '');
    expect(first.searchParams.get('parentRunId')).toBe('00000000-0000-4000-8000-000000000009');
    expect(first.searchParams.get('include')).toBe('output');
    expect(new URL(stub.calls[1]?.url ?? '').searchParams.get('topLevel')).toBe('true');
  });
});

describe('runs.get', () => {
  it('GETs /v1/runs/{runId}', async () => {
    const stub = jsonFetch(WIRE_RUN);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const run = await client.runs.get('00000000-0000-4000-8000-000000000001' as never);
    expect(run.status).toBe('queued');
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/runs/00000000-0000-4000-8000-000000000001',
    );
  });

  it('maps 404 run-not-found to NotFoundError', async () => {
    const stub = errorFetch(404, {
      code: 'run-not-found',
      message: 'no such run',
      details: { runId: 'x' },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.runs.get('x' as never)).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'run' } },
    });
  });
});

describe('runs.cancel', () => {
  it('POSTs /v1/runs/{runId}/cancel and returns Run', async () => {
    const stub = jsonFetch({ ...WIRE_RUN, status: 'cancelled' as const });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const run = await client.runs.cancel('00000000-0000-4000-8000-000000000001' as never, {
      idempotencyKey: 'idem-c',
    });
    expect(run.status).toBe('cancelled');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://api.example.com/v1/runs/00000000-0000-4000-8000-000000000001/cancel',
    );
    expect(req.headers['idempotency-key']).toBe('idem-c');
  });
});

describe('runs.resume', () => {
  it('POSTs /v1/runs/{runId}/resume with waitpointId + value', async () => {
    const stub = jsonFetch({ ...WIRE_RUN, status: 'running' as const });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const run = await client.runs.resume({
      runId: '00000000-0000-4000-8000-000000000001' as never,
      waitpointId: 'wp-1',
      value: { approved: true },
      idempotencyKey: 'idem-res',
    });

    expect(run.status).toBe('running');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://api.example.com/v1/runs/00000000-0000-4000-8000-000000000001/resume',
    );
    expect(req.headers['idempotency-key']).toBe('idem-res');
    expect(JSON.parse(req.body ?? '{}')).toMatchObject({
      waitpointId: 'wp-1',
      value: { approved: true },
    });
  });
});

describe('runs not-yet-wired surface', () => {
  it('dryRun throws not-yet-wired without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.runs.dryRun({ agent: 'a' as never, input: {} })).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'runs.dryRun' },
    });
    expect(stub.calls.length).toBe(0);
  });
});

// ============================================================
// runs.stream — SSE plumbing.
// @wire GET /v1/runs/{runId}/stream — see packages/api/src/routes/runs.ts
// ============================================================

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-000000000002';

const makeWireEvent = (sequence: number, kind: RunEvent['kind']): RunEvent => ({
  eventId: `${RUN_ID}:${sequence}`,
  runId: RUN_ID as never,
  tenantId: TENANT_ID as never,
  timestamp: '2026-09-20T00:00:00Z' as never,
  kind,
  sequence,
});

describe('runs.stream — happy path', () => {
  it('GETs /v1/runs/{runId}/stream with Authorization + Accept: text/event-stream and yields typed RunEvent frames', async () => {
    const stub = sseFetch([
      {
        frames: [
          { id: `${RUN_ID}:0`, event: 'run.started', data: makeWireEvent(0, 'run.started') },
          {
            id: `${RUN_ID}:1`,
            event: 'run.step-started',
            data: { ...makeWireEvent(1, 'run.step-started'), nodeId: 'n1' },
          },
          {
            id: `${RUN_ID}:2`,
            event: 'run.completed',
            data: makeWireEvent(2, 'run.completed'),
          },
        ],
      },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const collected: RunEvent[] = [];
    for await (const event of client.runs.stream(RUN_ID as never)) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
    expect(collected[0]?.kind).toBe('run.started');
    expect(collected[1]?.kind).toBe('run.step-started');
    expect(collected[1]?.nodeId).toBe('n1');
    expect(collected[2]?.kind).toBe('run.completed');

    // Wire contract: URL, method, headers.
    const req = stub.calls[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://api.example.com/v1/runs/${RUN_ID}/stream`);
    expect(req.headers.authorization).toBe('Bearer t');
    expect(req.headers.accept).toBe('text/event-stream');
    // First connect — no Last-Event-Id header.
    expect(req.headers['last-event-id']).toBeUndefined();
  });

  it('handles multi-frame chunks (SSE reader coalesces incremental buffer)', async () => {
    // One raw chunk containing three frames — exercises the reader's
    // buffer-then-split path.
    const combined =
      `id: ${RUN_ID}:0\nevent: run.started\ndata: ${JSON.stringify(makeWireEvent(0, 'run.started'))}\n\n` +
      `id: ${RUN_ID}:1\nevent: run.completed\ndata: ${JSON.stringify(makeWireEvent(1, 'run.completed'))}\n\n`;
    const stub = sseFetch([{ rawChunks: [combined] }]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const collected: RunEvent[] = [];
    for await (const event of client.runs.stream(RUN_ID as never)) {
      collected.push(event);
    }
    expect(collected.map((e) => e.kind)).toEqual(['run.started', 'run.completed']);
  });
});

describe('runs.stream — Last-Event-Id resume', () => {
  it('reconnects with Last-Event-Id set to the last-observed frame id after a mid-stream drop', async () => {
    const stub = sseFetch([
      {
        // First connection: emit one frame then error.
        rawChunks: [
          `id: ${RUN_ID}:5\nevent: run.step-completed\ndata: ${JSON.stringify({
            ...makeWireEvent(5, 'run.step-completed'),
            nodeId: 'n1',
          })}\n\n`,
        ],
        abortAfterChunk: 0,
      },
      {
        // Second connection: server resumes from seq 6.
        frames: [
          { id: `${RUN_ID}:6`, event: 'run.completed', data: makeWireEvent(6, 'run.completed') },
        ],
      },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
      // Zero backoff so the test doesn't sleep between attempts.
    });

    const collected: RunEvent[] = [];
    // Override backoff to 0 so the test runs fast.
    for await (const event of client.runs.stream(RUN_ID as never, {
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]?.eventId).toBe(`${RUN_ID}:5`);
    expect(collected[1]?.eventId).toBe(`${RUN_ID}:6`);

    // Two connection attempts made.
    expect(stub.calls).toHaveLength(2);
    // First connect: no resume marker.
    expect(stub.calls[0]?.headers['last-event-id']).toBeUndefined();
    // Second connect: resume marker set to first frame's id.
    expect(stub.calls[1]?.headers['last-event-id']).toBe(`${RUN_ID}:5`);
    // Auth header still present on the resume request.
    expect(stub.calls[1]?.headers.authorization).toBe('Bearer t');
  });
});

describe('runs.stream — AbortSignal cancellation', () => {
  it('completes cleanly without firing fetch when passed an already-aborted signal', async () => {
    const stub = sseFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const ac = new AbortController();
    ac.abort();

    const collected: RunEvent[] = [];
    for await (const event of client.runs.stream(RUN_ID as never, { signal: ac.signal })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('aborts mid-stream when the signal fires', async () => {
    const stub = sseFetch([
      {
        frames: [
          { id: `${RUN_ID}:0`, event: 'run.started', data: makeWireEvent(0, 'run.started') },
          {
            id: `${RUN_ID}:1`,
            event: 'run.step-started',
            data: { ...makeWireEvent(1, 'run.step-started'), nodeId: 'n1' },
          },
        ],
      },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const ac = new AbortController();
    const collected: RunEvent[] = [];
    for await (const event of client.runs.stream(RUN_ID as never, { signal: ac.signal })) {
      collected.push(event);
      ac.abort();
      break;
    }

    // We consumed one frame before breaking; the second remained in
    // the buffer + is dropped by the consumer's `break`.
    expect(collected).toHaveLength(1);
    expect(collected[0]?.kind).toBe('run.started');
  });
});

describe('runs.start — projectId on agent runs (POST /v1/runs accepts it)', () => {
  it('sends projectId for an agent run', async () => {
    const stub = jsonFetch(WIRE_RUN, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.runs.start({
      agent: 'acme.drafter' as never,
      projectId: 'proj-1',
      input: { draftId: 'd-1' },
    });

    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({
      agent: 'acme.drafter',
      projectId: 'proj-1',
      input: { draftId: 'd-1' },
    });
  });

  it('omits projectId when the caller does not set one', async () => {
    const stub = jsonFetch(WIRE_RUN, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.runs.start({ agent: 'acme.drafter' as never, input: {} });

    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).not.toHaveProperty('projectId');
  });
});
