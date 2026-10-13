// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Waiting out the server's rate limits: the helper, and the publishing
 * commands that go through the client (`flows`, `agents`, `blocks`
 * publish). `kindgi deploy`'s waits are in `deploy.test.ts`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, type KindgiError } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';
import {
  RATE_LIMIT_WAIT_CAP_MS,
  type RateLimitRefusal,
  callWaitingOutRateLimits,
  clientRefusal,
  sendWaitingOutRateLimits,
  waitLine,
} from '../src/rate-limit-wait.js';
import { fakeRateLimitWaits } from './rate-limit-waits.js';

const COMPILE_LINE =
  "The server's schema-compile-time limit is reached: sending it again in 23s.\n";

/** Answers in turn: a refusal (`retryAfterSeconds`), or `'ok'`. */
function answers(...script: (RateLimitRefusal | 'ok' | 'other')[]) {
  let sent = 0;
  return {
    sent: () => sent,
    send: async () => {
      const answer = script[Math.min(sent, script.length - 1)] as RateLimitRefusal | 'ok' | 'other';
      sent += 1;
      return answer;
    },
    refusalOf: (answer: RateLimitRefusal | 'ok' | 'other') =>
      typeof answer === 'string' ? undefined : answer,
  };
}

describe('sendWaitingOutRateLimits', () => {
  test('a refusal with a wait, then the answer: one line, one wait, sent twice', async () => {
    const waits = fakeRateLimitWaits();
    const script = answers({ retryAfterSeconds: 23, limit: 'schema-compile-time' }, 'ok');
    const answer = await sendWaitingOutRateLimits(
      { rateLimitWaits: waits.seam },
      script.send,
      script.refusalOf,
    );
    expect(answer).toBe('ok');
    expect(script.sent()).toBe(2);
    expect(waits.sleeps).toEqual([23_000]);
    expect(waits.lines).toEqual([COMPILE_LINE]);
  });

  test('a limit the server does not name is "rate limit"', () => {
    expect(waitLine(undefined, 5)).toBe(
      "The server's rate limit is reached: sending it again in 5s.\n",
    );
    expect(waitLine('schema-compile-time', 23)).toBe(COMPILE_LINE);
  });

  test('waits up to 10 minutes in all; the wait that would pass it is not made, and the refusal comes back', async () => {
    expect(RATE_LIMIT_WAIT_CAP_MS).toBe(600_000);
    const waits = fakeRateLimitWaits();
    const refusal = { retryAfterSeconds: 300 };
    // Finite, so a missing cap shows as an answer rather than a loop.
    const script = answers(refusal, refusal, refusal, refusal, 'ok');
    const answer = await sendWaitingOutRateLimits(
      { rateLimitWaits: waits.seam },
      script.send,
      script.refusalOf,
    );
    // 300 s, then 300 s more (10 minutes exactly), then not another 300.
    expect(answer).toBe(refusal);
    expect(script.sent()).toBe(3);
    expect(waits.sleeps).toEqual([300_000, 300_000]);
    expect(waits.lines).toEqual([
      "The server's rate limit is reached: sending it again in 300s.\n",
      "The server's rate limit is reached: sending it again in 300s.\n",
    ]);
  });

  test('the waiting is measured on the clock: a timer that fires late counts', async () => {
    const waits = fakeRateLimitWaits({ lateMs: 100_000 });
    const refusal = { retryAfterSeconds: 300 };
    const script = answers(refusal, refusal, refusal, 'ok');
    await sendWaitingOutRateLimits({ rateLimitWaits: waits.seam }, script.send, script.refusalOf);
    // 400 s on the clock after the first wait: another 300 would pass 10 minutes.
    expect(script.sent()).toBe(2);
    expect(waits.sleeps).toEqual([300_000]);
  });

  test('a refusal without a wait, or another answer, comes back at once', async () => {
    const waits = fakeRateLimitWaits();
    const script = answers('other', 'ok');
    expect(
      await sendWaitingOutRateLimits({ rateLimitWaits: waits.seam }, script.send, script.refusalOf),
    ).toBe('other');
    expect(script.sent()).toBe(1);
    expect(waits.sleeps).toEqual([]);
    expect(waits.lines).toEqual([]);
  });

  test('a Retry-After of 0 or a fraction waits whole seconds, at least one', async () => {
    const waits = fakeRateLimitWaits();
    const script = answers({ retryAfterSeconds: 0 }, { retryAfterSeconds: 1.2 }, 'ok');
    await sendWaitingOutRateLimits({ rateLimitWaits: waits.seam }, script.send, script.refusalOf);
    expect(waits.sleeps).toEqual([1_000, 2_000]);
  });

  test('Ctrl+C during a wait stops it: the refusal comes back, nothing is sent again', async () => {
    const stop = new AbortController();
    const waits = fakeRateLimitWaits({ onSleep: () => stop.abort() });
    const refusal = { retryAfterSeconds: 23 };
    const script = answers(refusal, 'ok');
    const answer = await sendWaitingOutRateLimits(
      { rateLimitWaits: waits.seam, stopSignal: stop.signal },
      script.send,
      script.refusalOf,
    );
    expect(answer).toBe(refusal);
    expect(script.sent()).toBe(1);
    expect(waits.lines).toHaveLength(1);
  });

  test('the real sleep ends when Ctrl+C comes', async () => {
    const stop = new AbortController();
    const script = answers({ retryAfterSeconds: 3600 }, 'ok');
    const lines: string[] = [];
    setTimeout(() => stop.abort(), 10);
    const answer = await sendWaitingOutRateLimits(
      { rateLimitWaits: { write: (line) => lines.push(line) }, stopSignal: stop.signal },
      script.send,
      script.refusalOf,
    );
    expect(answer).toEqual({ retryAfterSeconds: 3600 });
    expect(script.sent()).toBe(1);
  });
});

const rateLimited = (fields: Partial<Extract<KindgiError, { code: 'rate-limited' }>> = {}) =>
  new KindgiApiError({ code: 'rate-limited', message: 'Too many requests.', ...fields });

describe('callWaitingOutRateLimits and clientRefusal', () => {
  test("the client's rate-limited error with retryAfterSeconds is waited out; without, it's thrown", async () => {
    expect(
      clientRefusal(rateLimited({ retryAfterSeconds: 23, limit: 'schema-compile-time' })),
    ).toEqual({ retryAfterSeconds: 23, limit: 'schema-compile-time' });
    expect(clientRefusal(rateLimited())).toBeUndefined();
    expect(
      clientRefusal(
        new KindgiApiError({
          code: 'conflict',
          serverCode: 'idempotency-key-in-flight',
          message: 'still running',
          reason: 'idempotency-key-in-flight',
          retryAfterSeconds: 1,
        } as never),
      ),
    ).toBeUndefined();
    expect(clientRefusal(new Error('boom'))).toBeUndefined();
  });

  test('a call refused once with a wait returns the second answer; another error is thrown at once', async () => {
    const waits = fakeRateLimitWaits();
    let calls = 0;
    const value = await callWaitingOutRateLimits({ rateLimitWaits: waits.seam }, async () => {
      calls += 1;
      if (calls === 1) throw rateLimited({ retryAfterSeconds: 23, limit: 'schema-compile-time' });
      return 'published';
    });
    expect(value).toBe('published');
    expect(calls).toBe(2);
    expect(waits.lines).toEqual([COMPILE_LINE]);

    const refused = rateLimited();
    await expect(
      callWaitingOutRateLimits({ rateLimitWaits: waits.seam }, async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    expect(waits.lines).toHaveLength(1);
  });
});

// ---------- the client commands ----------

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const FLOW = {
  id: 'acme.intake',
  version: '1.0.0',
  nodes: [{ id: 'extract', kind: 'tool', ref: 'inline' }],
  edges: [],
};

/**
 * Run a command against a client whose publishing call throws each of
 * `refusals` in turn, then answers `answer`.
 */
async function publishing(
  argv: readonly string[],
  place: (publish: (...args: unknown[]) => Promise<unknown>) => Record<string, unknown>,
  refusals: readonly unknown[],
  answer: unknown = { ok: true },
) {
  const waits = fakeRateLimitWaits();
  const calls: unknown[][] = [];
  const publish = async (...args: unknown[]) => {
    calls.push(args);
    const refusal = refusals[calls.length - 1];
    if (refusal !== undefined) throw refusal;
    return answer;
  };
  const out = await runCli({
    argv: [...argv, '--project=p-1', '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => place(publish) as never,
    rateLimitWaits: waits.seam,
  });
  return { out, calls, lines: waits.lines, sleeps: waits.sleeps };
}

const flowsPublish = (refusals: readonly unknown[]) =>
  publishing(
    ['flows', 'publish', `--spec=${JSON.stringify(FLOW)}`],
    (define) => ({ flows: { define } }),
    refusals,
    { flowId: 'acme.intake', version: '1.0.0' },
  );

describe('kindgi flows publish: the server rate limit', () => {
  test('a 429 with Retry-After, then the answer: one line, published, sent twice the same', async () => {
    const run = await flowsPublish([
      rateLimited({ retryAfterSeconds: 23, limit: 'schema-compile-time' }),
    ]);
    expect(run.out.exitCode, run.out.stderr).toBe(0);
    expect(JSON.parse(run.out.stdout)).toEqual({ flowId: 'acme.intake', version: '1.0.0' });
    expect(run.lines).toEqual([COMPILE_LINE]);
    expect(run.sleeps).toEqual([23_000]);
    expect(run.calls).toEqual([
      [FLOW, { projectId: 'p-1' }],
      [FLOW, { projectId: 'p-1' }],
    ]);
  });

  test('waits that would pass 10 minutes: it stops, and fails as without waiting', async () => {
    const refusal = rateLimited({ retryAfterSeconds: 250 });
    const run = await flowsPublish([refusal, refusal, refusal, refusal]);
    const once = await flowsPublish([rateLimited()]);
    expect(run.out.exitCode).toBe(1);
    expect(run.out.stderr).toBe(once.out.stderr);
    expect(run.out.stderr).toContain('Too many requests.');
    expect(run.out.stdout).toBe('');
    // 250 s, 500 s; a third would make 750.
    expect(run.sleeps).toEqual([250_000, 250_000]);
    expect(run.lines).toEqual([
      "The server's rate limit is reached: sending it again in 250s.\n",
      "The server's rate limit is reached: sending it again in 250s.\n",
    ]);
    expect(run.calls).toHaveLength(3);
  });

  test('a 429 without Retry-After: no wait, it fails at once', async () => {
    const run = await flowsPublish([rateLimited()]);
    expect(run.out.exitCode).toBe(1);
    expect(run.out.stderr).toContain('Too many requests.');
    expect(run.calls).toHaveLength(1);
    expect(run.lines).toEqual([]);
    expect(run.sleeps).toEqual([]);
  });

  test('another error, with a Retry-After or not: no wait', async () => {
    const inFlight = new KindgiApiError({
      code: 'conflict',
      serverCode: 'idempotency-key-in-flight',
      message: 'A request with this Idempotency-Key is still running.',
      reason: 'idempotency-key-in-flight',
      retryAfterSeconds: 1,
    } as never);
    const invalid = new KindgiApiError({
      code: 'invalid-request',
      message: 'The flow has a cycle.',
      issues: [],
    });
    for (const error of [inFlight, invalid]) {
      const run = await flowsPublish([error]);
      expect(run.out.exitCode).toBe(1);
      expect(run.out.stderr).toContain(error.message);
      expect(run.calls).toHaveLength(1);
      expect(run.lines).toEqual([]);
    }
  });
});

describe('kindgi agents publish and blocks publish: the server rate limit', () => {
  test.each([
    {
      name: 'agents publish',
      argv: ['agents', 'publish', '--spec={"id":"acme.drafter"}'],
      place: (define: unknown) => ({ agents: { define } }),
    },
    {
      name: 'blocks publish (a prompt)',
      argv: ['blocks', 'publish', 'acme.intake', '--block-version=1.0.0', '--prompt=Hi'],
      place: (publish: unknown) => ({ blocks: { publish } }),
    },
    {
      name: 'blocks publish (a definition)',
      argv: ['blocks', 'publish', '{"id":"acme.intake","version":"1.0.0"}'],
      place: (publish: unknown) => ({ blocks: { publish } }),
    },
  ])('$name: a 429 with Retry-After is waited out, then sent again', async ({ argv, place }) => {
    const run = await publishing(argv, place, [
      rateLimited({ retryAfterSeconds: 23, limit: 'schema-compile-time' }),
    ]);
    expect(run.out.exitCode, run.out.stderr).toBe(0);
    expect(run.lines).toEqual([COMPILE_LINE]);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]).toEqual(run.calls[0]);
  });
});
