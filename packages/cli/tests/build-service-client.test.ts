// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The build service's client (`postBuildReal`, `streamBuildLogsReal`)
 * against a fake `fetch`: what it sends, the refusals it reads, and a log
 * stream cut before its end, which it opens again.
 */

import { describe, expect, test } from 'vitest';

import { postBuildReal, streamBuildLogsReal } from '../src/build/defaults.js';
import { BuildServiceRefusal } from '../src/build/hosted.js';

const ENDPOINT = 'https://platform.example.com/cloud';
const AUTH = 'Bearer kgi_tk_test-key';

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body?: FormData;
}

/** A `fetch` answering each request in turn, keeping what was sent. */
function fakeFetch(answers: readonly (() => Response)[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      ...(init?.body instanceof FormData && { body: init.body }),
    });
    const answer = answers[sent.length - 1];
    if (answer === undefined) throw new Error(`no answer for request ${sent.length}`);
    return answer();
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const queued = () =>
  Response.json(
    { buildJobId: 'job-1', status: 'queued', buildLogsUrl: '/v1/build/job-1/stream' },
    { status: 202 },
  );

const post = (fetchImpl: typeof fetch, extra: Record<string, string> = {}) =>
  postBuildReal({
    endpoint: ENDPOINT,
    tarballBytes: new Uint8Array([1, 2, 3]),
    tarballSha256: 'abc',
    buildTarget: 'staging',
    fetchImpl,
    ...extra,
  });

describe('postBuildReal', () => {
  test('sends the key, the pack id and the project label when given', async () => {
    const { fetchImpl, sent } = fakeFetch([queued]);
    const posted = await post(fetchImpl, {
      authorization: AUTH,
      packId: 'acme-shop',
      projectId: 'p-1',
    });
    expect(posted.buildJobId).toBe('job-1');
    expect(sent[0]?.url).toBe(`${ENDPOINT}/v1/build`);
    expect(sent[0]?.headers.get('authorization')).toBe(AUTH);
    expect(sent[0]?.body?.get('packId')).toBe('acme-shop');
    expect(sent[0]?.body?.get('projectId')).toBe('p-1');
  });

  test('without them, sends neither a key nor the fields', async () => {
    const { fetchImpl, sent } = fakeFetch([queued]);
    await post(fetchImpl);
    expect(sent[0]?.headers.has('authorization')).toBe(false);
    expect(sent[0]?.body?.has('packId')).toBe(false);
    expect(sent[0]?.body?.has('projectId')).toBe(false);
  });

  test('a `{ error }` answer is a refusal: its status, code, message and Retry-After', async () => {
    const { fetchImpl } = fakeFetch([
      () =>
        Response.json(
          { error: { code: 'rate-limit-exceeded', message: 'One build at a time.' } },
          { status: 429, headers: { 'retry-after': '10' } },
        ),
    ]);
    const thrown = await post(fetchImpl).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(BuildServiceRefusal);
    expect(thrown).toMatchObject({
      status: 429,
      code: 'rate-limit-exceeded',
      message: 'One build at a time.',
      retryAfterSeconds: 10,
    });
  });

  test('an answer that is no refusal is an error naming the status', async () => {
    const { fetchImpl } = fakeFetch([() => new Response('bad gateway', { status: 502 })]);
    await expect(post(fetchImpl)).rejects.toThrow(
      'POST /v1/build failed with HTTP 502: bad gateway',
    );
  });
});

/** An SSE answer: `log` frames, then a `terminal` one when given. */
function stream(lines: readonly string[], terminal?: Record<string, unknown>): () => Response {
  const frames = lines.map((line) => `event: log\ndata: ${JSON.stringify({ line })}\n\n`);
  if (terminal !== undefined) frames.push(`event: terminal\ndata: ${JSON.stringify(terminal)}\n\n`);
  return () =>
    new Response(frames.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
}

const COMPLETED = { status: 'completed', imageRef: 'r@sha256:1', imageDigest: 'sha256:1' };

function follow(fetchImpl: typeof fetch, signal?: AbortSignal) {
  const logged: string[] = [];
  const sleeps: number[] = [];
  const following = streamBuildLogsReal({
    endpoint: ENDPOINT,
    buildJobId: 'job-1',
    authorization: AUTH,
    fetchImpl,
    onLog: (line) => logged.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(signal !== undefined && { signal }),
  });
  return { following, logged, sleeps };
}

describe('streamBuildLogsReal', () => {
  test('a stream cut before its end is opened again; the replayed lines are given once', async () => {
    const { fetchImpl, sent } = fakeFetch([
      stream(['one', 'two']),
      stream(['one', 'two', 'three'], COMPLETED),
    ]);
    const { following, logged, sleeps } = follow(fetchImpl);
    await expect(following).resolves.toMatchObject({
      status: 'completed',
      imageDigest: 'sha256:1',
    });
    expect(logged).toEqual(['one', 'two', 'three']);
    expect(sleeps).toEqual([1_000]);
    expect(sent.map((s) => s.url)).toEqual([
      `${ENDPOINT}/v1/build/job-1/stream`,
      `${ENDPOINT}/v1/build/job-1/stream`,
    ]);
    expect(sent.every((s) => s.headers.get('authorization') === AUTH)).toBe(true);
  });

  test("a refused opening waits the answer's Retry-After", async () => {
    const busy = () =>
      Response.json(
        { error: { code: 'build-queue-busy', message: 'Busy.' } },
        { status: 503, headers: { 'retry-after': '7' } },
      );
    const { fetchImpl } = fakeFetch([stream(['one']), busy, stream(['one', 'two'], COMPLETED)]);
    const { following, logged, sleeps } = follow(fetchImpl);
    await expect(following).resolves.toMatchObject({ status: 'completed' });
    expect(logged).toEqual(['one', 'two']);
    expect(sleeps).toEqual([1_000, 7_000]);
  });

  test('a 404 (or 401, 403, 410) ends it at once, as the refusal', async () => {
    const gone = () =>
      Response.json(
        { error: { code: 'build-job-not-found', message: 'No such job.' } },
        { status: 404 },
      );
    const { fetchImpl, sent } = fakeFetch([stream(['one']), gone]);
    const { following } = follow(fetchImpl);
    await expect(following).rejects.toMatchObject({ status: 404, code: 'build-job-not-found' });
    expect(sent).toHaveLength(2);
  });

  test('five openings in a row with nothing new: it gives up, naming the job', async () => {
    const same = stream(['one']);
    const { fetchImpl, sent } = fakeFetch([same, same, same, same, same, same]);
    const { following, sleeps } = follow(fetchImpl);
    await expect(following).rejects.toThrow(
      "The build's log stream ended 5 times in a row without its end or a new line",
    );
    // The first opening brought a line; the next five brought nothing.
    expect(sent).toHaveLength(6);
    expect(sleeps).toEqual([1_000, 1_000, 2_000, 4_000, 8_000]);
  });

  test('stopped (Ctrl+C) while it waits: it stops following', async () => {
    const stop = new AbortController();
    const { fetchImpl } = fakeFetch([
      () => {
        stop.abort();
        return stream(['one'])();
      },
    ]);
    const { following } = follow(fetchImpl, stop.signal);
    await expect(following).rejects.toThrow("Stopped following the build's log");
  });
});
