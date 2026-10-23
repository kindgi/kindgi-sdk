// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { type ToolConnection, isConnectionRejectedError, toolContextForTest } from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AppCall, appFetch } from '../src/app-fetch.js';
import { github } from '../src/github.js';
import { google } from '../src/google.js';
import { defineApp } from '../src/index.js';

const TOKEN = 'ya29.not-a-real-token';

function connection(app = 'google', connectionId = randomUUID()): ToolConnection {
  return {
    connectionId,
    app,
    appName: app === 'google' ? 'Google' : 'GitHub',
    accessToken: TOKEN,
    account: { id: 'acct-1', label: 'ana@acme.test' },
  };
}

/** A fetch stub answering each call with the next of `answers` (the last one repeats), keeping what it was sent. */
function fetchAnswering(...answers: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)] as () => Response;
    return next();
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const ok = () => new Response('{"ok":true}', { status: 200 });

function call(over: Partial<AppCall> = {}): AppCall {
  return {
    entry: google,
    connection: 'mail',
    toolId: 'acme.read-mail',
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('appFetch', () => {
  it("sends the connection's token as a bearer, with the call's method, headers and body", async () => {
    const calls = fetchAnswering(ok);
    const ctx = toolContextForTest({ connections: { mail: connection() } });
    const res = await appFetch(
      ctx,
      call({
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"raw":"x"}',
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{"raw":"x"}',
      signal: ctx.abortSignal,
    });
  });

  it("the connection's token is the only Authorization sent, whatever case a caller's own had", async () => {
    const calls = fetchAnswering(ok);
    await appFetch(
      toolContextForTest({ connections: { mail: connection() } }),
      call({
        headers: {
          Authorization: 'Bearer other',
          AUTHORIZATION: 'Basic b3RoZXI=',
          accept: 'text/plain',
        },
      }),
    );
    const sent = new Headers(calls[0]?.init.headers);
    expect(sent.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(sent.get('accept')).toBe('text/plain');
  });

  it("a 401 throws ConnectionRejectedError naming the tool's connection, never the token", async () => {
    fetchAnswering(() => new Response('{"error":"invalid_token"}', { status: 401 }));
    const err = await appFetch(
      toolContextForTest({ connections: { mail: connection() } }),
      call(),
    ).catch((e: unknown) => e);
    expect(isConnectionRejectedError(err)).toBe(true);
    expect(err).toMatchObject({ connection: 'mail', code: 'connection-rejected' });
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it('a connection the call lacks, or one to another app, is an error before anything is sent', async () => {
    const calls = fetchAnswering(ok);
    await expect(appFetch(toolContextForTest(), call())).rejects.toThrow(
      'This call has no connection "mail"',
    );
    await expect(
      appFetch(toolContextForTest({ connections: { mail: connection('github') } }), call()),
    ).rejects.toThrow('The connection "mail" is to GitHub, not Google.');
    expect(calls).toHaveLength(0);
  });

  it("a 429 is tried again after the app's Retry-After", async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering(
      () => new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      ok,
    );
    const p = appFetch(toolContextForTest({ connections: { mail: connection() } }), call());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('with no time given, it waits 1 s, then 2 s, and the third busy answer goes back to the tool', async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering(() => new Response('', { status: 429 }));
    const p = appFetch(toolContextForTest({ connections: { mail: connection() } }), call());
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await p).status).toBe(429);
    expect(calls).toHaveLength(3);
  });

  it("a wait the app asks for past 30 s isn't waited out: its answer goes back at once", async () => {
    const calls = fetchAnswering(
      () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const res = await appFetch(toolContextForTest({ connections: { mail: connection() } }), call());
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it('a 503 is tried again for a GET, never for a POST: the app may have done it', async () => {
    vi.useFakeTimers();
    const getCalls = fetchAnswering(() => new Response('', { status: 503 }), ok);
    const got = appFetch(toolContextForTest({ connections: { mail: connection() } }), call());
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await got).status).toBe(200);
    expect(getCalls).toHaveLength(2);

    const postCalls = fetchAnswering(() => new Response('', { status: 503 }), ok);
    const posted = await appFetch(
      toolContextForTest({ connections: { mail: connection() } }),
      call({ method: 'POST', body: '{}' }),
    );
    expect(posted.status).toBe(503);
    expect(postCalls).toHaveLength(1);
  });

  it("GitHub's spent rate limit (a 403 saying so) waits for its reset; any other 403 is the tool's", async () => {
    vi.useFakeTimers();
    // Reset in whole seconds, as GitHub gives it: between 4 and 5 s from now.
    const reset = Math.floor(Date.now() / 1000) + 5;
    const spent = fetchAnswering(
      () =>
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        }),
      ok,
    );
    const gh = { connections: { github: connection('github') } };
    const p = appFetch(
      toolContextForTest(gh),
      call({
        entry: github,
        connection: 'github',
        url: 'https://api.github.com/repos/acme/widgets',
      }),
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(spent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).status).toBe(200);

    const refused = fetchAnswering(
      () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 }),
    );
    const res = await appFetch(
      toolContextForTest(gh),
      call({
        entry: github,
        connection: 'github',
        url: 'https://api.github.com/repos/acme/widgets',
      }),
    );
    expect(res.status).toBe(403);
    expect(refused).toHaveLength(1);
  });

  it('an answer that spends the last of the rate limit goes back at once, never sent again: only a 403 or 429 says to wait', async () => {
    // GitHub sends these on the call that spent the last unit; that call was done.
    const calls = fetchAnswering(
      () =>
        new Response('[{"name":"bug"}]', {
          status: 200,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
          },
        }),
    );
    const res = await appFetch(
      toolContextForTest({ connections: { github: connection('github') } }),
      call({
        entry: github,
        connection: 'github',
        method: 'POST',
        url: 'https://api.github.com/repos/acme/widgets/issues/12/labels',
        body: '{"labels":["bug"]}',
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("GitHub's secondary rate limit (a 403 with Retry-After) waits as it asks", async () => {
    vi.useFakeTimers();
    const calls = fetchAnswering(
      () =>
        new Response('{"message":"You have exceeded a secondary rate limit."}', {
          status: 403,
          headers: { 'retry-after': '2' },
        }),
      ok,
    );
    const p = appFetch(
      toolContextForTest({ connections: { github: connection('github') } }),
      call({
        entry: github,
        connection: 'github',
        url: 'https://api.github.com/repos/acme/widgets',
      }),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("Google's rate limit in a 403's body is tried again; its other 403s go back to the tool, readable", async () => {
    vi.useFakeTimers();
    const googleSays = (reason: string) => () =>
      Response.json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            errors: [{ domain: 'usageLimits', reason }],
          },
        },
        { status: 403 },
      );
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
      const calls = fetchAnswering(googleSays(reason), ok);
      const p = appFetch(toolContextForTest({ connections: { mail: connection() } }), call());
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).status).toBe(200);
      expect(calls).toHaveLength(2);
    }

    for (const reason of ['dailyLimitExceeded', 'insufficientPermissions']) {
      const calls = fetchAnswering(googleSays(reason), ok);
      const res = await appFetch(
        toolContextForTest({ connections: { mail: connection() } }),
        call(),
      );
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(1);
      expect(await res.json()).toMatchObject({ error: { errors: [{ reason }] } });
    }
  });

  it("paces calls by the entry's rate limit, per connection, charging each tool its cost", async () => {
    vi.useFakeTimers();
    const app = defineApp({
      ...google,
      id: 'paced',
      rateLimits: [{ per: 'connection', units: 4, perSeconds: 1, costs: { 'acme.big': 2 } }],
    });
    const calls = fetchAnswering(ok);
    const mine = toolContextForTest({ connections: { mail: connection('paced') } });
    const paced = (toolId: string, ctx = mine) => appFetch(ctx, call({ entry: app, toolId }));

    // A full bucket of 4: two big calls (2 each) go at once.
    await paced('acme.big');
    await paced('acme.big');
    expect(calls).toHaveLength(2);
    // Empty: a small call (1) waits a quarter of a second for a unit.
    const third = paced('acme.small');
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await third;
    expect(calls).toHaveLength(3);
    // Another connection has its own bucket.
    await paced('acme.big', toolContextForTest({ connections: { mail: connection('paced') } }));
    expect(calls).toHaveLength(4);
  });

  it('a call costing more than the bucket holds takes the whole bucket, not forever', async () => {
    vi.useFakeTimers();
    const app = defineApp({
      ...google,
      id: 'tiny',
      rateLimits: [{ per: 'connection', units: 1, perSeconds: 1, costs: { 'acme.huge': 50 } }],
    });
    const calls = fetchAnswering(ok);
    const ctx = toolContextForTest({ connections: { mail: connection('tiny') } });
    await appFetch(ctx, call({ entry: app, toolId: 'acme.huge' }));
    const second = appFetch(ctx, call({ entry: app, toolId: 'acme.huge' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(calls).toHaveLength(2);
  });

  it("every wait ends when the call's signal fires", async () => {
    vi.useFakeTimers();
    fetchAnswering(() => new Response('', { status: 429, headers: { 'retry-after': '10' } }));
    const abort = new AbortController();
    const p = appFetch(
      toolContextForTest({ abortSignal: abort.signal, connections: { mail: connection() } }),
      call(),
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    abort.abort(new Error('run cancelled'));
    expect(await p).toMatchObject({ message: 'run cancelled' });
  });
});
