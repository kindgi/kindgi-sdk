// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { SseHttpError, createClient, subscribeToRun } from '../src/index.js';

const API = 'https://api.example.com';
const RUN = 'run-1';

function frame(sequence: number, kind: string): string {
  const data = {
    eventId: `${RUN}:${sequence}`,
    runId: RUN,
    timestamp: '2026-10-01T00:00:00Z',
    kind,
    sequence,
  };
  return `id: ${RUN}:${sequence}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sse(body: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

interface Call {
  readonly authorization: string | null;
  readonly lastEventId: string | null;
}

/** A fetch that answers each call with the next scripted response. */
function scriptedFetch(responses: readonly (() => Response)[]): {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get('authorization'),
      lastEventId: headers.get('last-event-id'),
    });
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error('no more scripted responses');
    return next();
  };
  return { fetch: impl as typeof fetch, calls };
}

const unauthorized = () => new Response('{"error":{"code":"auth-expired"}}', { status: 401 });

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('subscribeToRun', () => {
  it('follows the progress stream, reconnecting after the last event until the terminal one', async () => {
    const script = scriptedFetch([
      () => sse(frame(0, 'run.started') + frame(1, 'run.step-started')),
      () => sse(frame(2, 'run.step-completed') + frame(3, 'run.completed')),
    ]);
    const events = await collect(
      subscribeToRun({
        apiUrl: `${API}/`,
        runId: RUN,
        accessToken: 'kgi_pt_a',
        fetch: script.fetch,
      }),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'run.started',
      'run.step-started',
      'run.step-completed',
      'run.completed',
    ]);
    expect(script.calls).toEqual([
      { authorization: 'Bearer kgi_pt_a', lastEventId: null },
      { authorization: 'Bearer kgi_pt_a', lastEventId: `${RUN}:1` },
    ]);
  });

  it('refreshes an expired token and continues where it left off', async () => {
    const script = scriptedFetch([
      () => sse(frame(0, 'run.started')),
      unauthorized,
      () => sse(frame(1, 'run.completed')),
    ]);
    let refreshed = 0;
    const events = await collect(
      subscribeToRun({
        apiUrl: API,
        runId: RUN,
        accessToken: 'kgi_pt_old',
        refreshAccessToken: async () => {
          refreshed += 1;
          return 'kgi_pt_new';
        },
        fetch: script.fetch,
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(['run.started', 'run.completed']);
    expect(refreshed).toBe(1);
    expect(script.calls.map((c) => c.authorization)).toEqual([
      'Bearer kgi_pt_old',
      'Bearer kgi_pt_old',
      'Bearer kgi_pt_new',
    ]);
    expect(script.calls[2]?.lastEventId).toBe(`${RUN}:0`);
  });

  it('without a refresh callback, an expired token ends the subscription with the 401', async () => {
    const script = scriptedFetch([unauthorized]);
    const result = collect(
      subscribeToRun({ apiUrl: API, runId: RUN, accessToken: 'kgi_pt_old', fetch: script.fetch }),
    );
    await expect(result).rejects.toBeInstanceOf(SseHttpError);
    expect(script.calls).toHaveLength(1);
  });

  it('gives up after three refreshes in a row that still answer 401', async () => {
    const script = scriptedFetch([unauthorized, unauthorized, unauthorized, unauthorized]);
    let refreshed = 0;
    const result = collect(
      subscribeToRun({
        apiUrl: API,
        runId: RUN,
        accessToken: 'kgi_pt_a',
        refreshAccessToken: async () => {
          refreshed += 1;
          return `kgi_pt_${refreshed}`;
        },
        fetch: script.fetch,
      }),
    );
    await expect(result).rejects.toMatchObject({ status: 401 });
    expect(refreshed).toBe(3);
  });

  it('a 404 is not retried', async () => {
    const script = scriptedFetch([() => new Response('{}', { status: 404 })]);
    const result = collect(
      subscribeToRun({ apiUrl: API, runId: RUN, accessToken: 'kgi_pt_a', fetch: script.fetch }),
    );
    await expect(result).rejects.toMatchObject({ status: 404 });
    expect(script.calls).toHaveLength(1);
  });
});

describe('subscribeToRun — the URL', () => {
  it('is the progress stream, with the API base URL trimmed', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      return sse(frame(0, 'run.completed'));
    }) as typeof fetch;
    await collect(
      subscribeToRun({
        apiUrl: `${API}//`,
        runId: 'r/1',
        accessToken: 'kgi_pt_a',
        fetch: fetchImpl,
      }),
    );
    expect(urls).toEqual([`${API}/v1/runs/r%2F1/progress/stream`]);
  });
});

describe('runs.stream follows the run to its end', () => {
  it('reconnects with Last-Event-Id when the server closes before the terminal event', async () => {
    const script = scriptedFetch([
      () => sse(frame(0, 'run.started')),
      () => sse(frame(1, 'run.failed')),
    ]);
    const client = createClient({
      apiUrl: API,
      auth: { kind: 'apiToken', token: 'kgi_bt_secret' },
      fetch: script.fetch,
    });
    const events = await collect(client.runs.stream(RUN as never));
    expect(events.map((e) => e.kind)).toEqual(['run.started', 'run.failed']);
    expect(script.calls[1]).toEqual({
      authorization: 'Bearer kgi_bt_secret',
      lastEventId: `${RUN}:0`,
    });
  });
});

describe('tokens.createPublic', () => {
  it('POST /v1/tokens/public with the run ids and lifetime', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const client = createClient({
      apiUrl: API,
      auth: { kind: 'apiToken', token: 'kgi_bt_secret' },
      fetch: (async (url: unknown, init?: RequestInit) => {
        seen = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(
          JSON.stringify({ token: 'kgi_pt_x', expiresAt: '2026-10-01T00:15:00Z', runIds: [RUN] }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const minted = await client.tokens.createPublic({ runIds: [RUN], expiresInSeconds: 600 });
    expect(minted.token).toBe('kgi_pt_x');
    expect(seen).toEqual({
      url: `${API}/v1/tokens/public`,
      body: { runIds: [RUN], expiresInSeconds: 600 },
    });
  });
});
